(function() {
  // Reconcile instead of bailing: if a previous overlay layer is still present
  // (e.g. left behind by an SPA navigation where the DOM was not wiped), tear it
  // down first so this injection always installs fresh capture-phase handlers for
  // the current `window.__termul_annotation_mode`. Silently returning here would
  // leave stale (or, after a cancelled removal, absent) handlers bound.
  //
  // The previous overlay's cleanup `delete`s the mode/tab-id globals that the Rust
  // bootstrap just set before this script ran, so snapshot and restore them around
  // the teardown to preserve the requested mode/tab for this fresh injection.
  var __termul_existing_layer = document.getElementById('__termul_annotation_layer');
  if (__termul_existing_layer) {
    var __termul_pending_mode = window.__termul_annotation_mode;
    var __termul_pending_tab_id = window.__termul_annotation_tab_id;
    if (typeof window.__termul_remove_annotation_overlay === 'function') {
      try {
        window.__termul_remove_annotation_overlay();
      } catch (e) {}
    }
    // Sweep any layer node still present — covers a missing cleanup fn, a throw
    // mid-teardown, or a partial cleanup that left the node behind. Guarantees the
    // fresh overlay below never collides with a stale duplicate-ID node.
    var __termul_stale = document.getElementById('__termul_annotation_layer');
    while (__termul_stale) {
      __termul_stale.remove();
      __termul_stale = document.getElementById('__termul_annotation_layer');
    }
    window.__termul_annotation_mode = __termul_pending_mode;
    window.__termul_annotation_tab_id = __termul_pending_tab_id;
  }

  var OVERLAY_ID = '__termul_annotation_layer';
  var RECT_ID = '__termul_annotation_rect';
  var HIGHLIGHT_ID = '__termul_annotation_highlight';
  var MAX_TEXT_CONTENT_LENGTH = 2000;
  var MAX_SELECTOR_LENGTH = 500;
  var MAX_ATTRIBUTE_VALUE_LENGTH = 500;
  var ATTRIBUTE_ALLOWLIST = [
    'id',
    'class',
    'name',
    'role',
    'type',
    'aria-label',
    'aria-describedby',
    'data-testid'
  ];

  var mode = window.__termul_annotation_mode === 'select' ? 'select' : 'draw';
  var overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = mode === 'select'
    ? 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;pointer-events:none;background:transparent;'
    : 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;cursor:crosshair;pointer-events:auto;background:transparent;';

  var previousCursor = document.documentElement.style.cursor;
  if (mode === 'select') {
    document.documentElement.style.cursor = 'pointer';
  }

  var startX = 0;
  var startY = 0;
  var rectEl = null;
  var highlightEl = null;
  var isDragging = false;
  var trackedElement = null;
  var highlightRafId = 0;

  function invoke(cmd, args) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke(cmd, args);
        return true;
      }
    } catch (e) {}
    try {
      if (window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke(cmd, args);
        return true;
      }
    } catch (e) {}
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke(cmd, args);
        return true;
      }
    } catch (e) {}
    return false;
  }

  function stripControlChars(value) {
    return String(value == null ? '' : value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  function truncateWithEllipsis(value, maxLength) {
    if (value.length <= maxLength) {
      return { value: value, truncated: false };
    }

    return {
      value: value.slice(0, Math.max(0, maxLength - 1)) + '…',
      truncated: true
    };
  }

  function sanitizeAndTruncate(value, maxLength) {
    return truncateWithEllipsis(stripControlChars(value), maxLength);
  }

  function isOverlayElement(element) {
    return !!(
      element && (
        element.id === OVERLAY_ID ||
        element.id === RECT_ID ||
        element.id === HIGHLIGHT_ID ||
        element === overlay ||
        element === rectEl ||
        element === highlightEl
      )
    );
  }

  var SENSITIVE_ARIA_ROLES = {
    'textbox': true,
    'combobox': true,
    'listbox': true,
    'spinbutton': true,
    'slider': true,
    'searchbox': true
  };

  function isSensitiveElement(element) {
    if (!element || !(element instanceof Element)) return true;

    var tagName = element.tagName.toLowerCase();

    // Password check first — uses live IDL property so dynamically-changed types are caught
    if (tagName === 'input' && element.type === 'password') return true;

    // All other input elements + textarea
    if (tagName === 'input' || tagName === 'textarea') return true;

    // Form-associated elements that contain structured data or live values
    if (tagName === 'select' || tagName === 'datalist' || tagName === 'output') return true;

    // ARIA widget role heuristics — custom form controls that hold user-entered values
    // role attribute is a space-separated token list; check each token
    var roleAttr = element.getAttribute('role');
    if (roleAttr) {
      var roleTokens = roleAttr.toLowerCase().split(/\s+/);
      for (var ri = 0; ri < roleTokens.length; ri += 1) {
        if (SENSITIVE_ARIA_ROLES[roleTokens[ri]]) return true;
      }
    }
    if (element.hasAttribute('aria-valuetext') || element.hasAttribute('aria-valuenow')) return true;

    // contenteditable check: must filter for true/empty (which means true)
    // contenteditable="false" explicitly disables editing, so don't block those
    var editableAncestor = element.closest('[contenteditable]');
    if (editableAncestor) {
      var editableValue = editableAncestor.getAttribute('contenteditable');
      // contenteditable="" or "true" or "plaintext-only" are all editable
      if (editableValue === '' || editableValue === 'true' || editableValue === 'plaintext-only') {
        return true;
      }
    }
    
    // Also check if the element itself has isContentEditable (live property)
    if (element.isContentEditable) return true;

    return false;
  }

  function hasVisibleBounds(element) {
    if (!element || !document.contains(element)) return false;
    var rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function ensureHighlight() {
    if (highlightEl) return highlightEl;

    highlightEl = document.createElement('div');
    highlightEl.id = HIGHLIGHT_ID;
    highlightEl.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:0',
      'height:0',
      'z-index:2147483647',
      'pointer-events:none',
      'border:2px dashed #f97316',
      'background:transparent',
      'box-sizing:border-box',
      'display:none'
    ].join(';');
    document.body.appendChild(highlightEl);
    return highlightEl;
  }

  function hideHighlight() {
    if (!highlightEl) return;
    highlightEl.style.display = 'none';
  }

  function stopHighlightTracking() {
    if (highlightRafId) {
      cancelAnimationFrame(highlightRafId);
      highlightRafId = 0;
    }
  }

  function clearTrackedElement() {
    trackedElement = null;
    stopHighlightTracking();
    hideHighlight();
  }

  function updateHighlightFrame() {
    highlightRafId = 0;

    if (!trackedElement || !document.contains(trackedElement)) {
      clearTrackedElement();
      return;
    }

    var rect = trackedElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      clearTrackedElement();
      return;
    }

    var highlight = ensureHighlight();
    highlight.style.display = 'block';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';

    highlightRafId = requestAnimationFrame(updateHighlightFrame);
  }

  function setTrackedElement(element) {
    if (element === trackedElement) return;

    trackedElement = element;
    stopHighlightTracking();

    if (!trackedElement) {
      hideHighlight();
      return;
    }

    highlightRafId = requestAnimationFrame(updateHighlightFrame);
  }

  function resolveElementAtPoint(clientX, clientY) {
    var previousOverlayDisplay = overlay.style.display;
    var previousHighlightDisplay = highlightEl ? highlightEl.style.display : '';
    var previousMarkerDisplay = markerContainer ? markerContainer.style.display : '';

    overlay.style.display = 'none';
    if (highlightEl) {
      highlightEl.style.display = 'none';
    }
    if (markerContainer) {
      markerContainer.style.display = 'none';
    }

    var element = document.elementFromPoint(clientX, clientY);

    overlay.style.display = previousOverlayDisplay;
    if (highlightEl) {
      highlightEl.style.display = previousHighlightDisplay;
    }
    if (markerContainer) {
      markerContainer.style.display = previousMarkerDisplay;
    }

    if (!element || !document.contains(element)) return null;
    if (element === document.documentElement || element === document.body) return null;
    if (isOverlayElement(element)) return null;
    if (isMarkerElement(element)) return null;

    return element;
  }

  function getElementChildIndex(element) {
    var parent = element.parentElement;
    if (!parent) return 1;

    var children = parent.children;
    for (var index = 0; index < children.length; index += 1) {
      if (children[index] === element) {
        return index + 1;
      }
    }

    return 1;
  }

  function generateSelector(element) {
    var tagName = element.tagName.toLowerCase();

    if (element.id) {
      var escapedId = CSS.escape(element.id);
      var idSelector = '#' + escapedId;
      if (document.querySelectorAll(idSelector).length === 1) {
        return {
          selector: sanitizeAndTruncate(idSelector, MAX_SELECTOR_LENGTH).value,
          selectorConfidence: 'unique-id'
        };
      }
    }

    if (element.classList && element.classList.length > 0) {
      var classes = Array.prototype.slice.call(element.classList)
        .filter(function(className) {
          return !!className;
        })
        .map(function(className) {
          return '.' + CSS.escape(className);
        });

      if (classes.length > 0) {
        var classSelector = tagName + classes.join('');
        if (document.querySelectorAll(classSelector).length === 1) {
          return {
            selector: sanitizeAndTruncate(classSelector, MAX_SELECTOR_LENGTH).value,
            selectorConfidence: 'unique-class'
          };
        }
      }
    }

    var segments = [];
    var current = element;
    while (current && current !== document.body) {
      segments.unshift(current.tagName.toLowerCase() + ':nth-child(' + getElementChildIndex(current) + ')');
      current = current.parentElement;
    }

    var fallbackSelector = segments.length > 0 ? 'body > ' + segments.join(' > ') : 'body';
    return {
      selector: sanitizeAndTruncate(fallbackSelector, MAX_SELECTOR_LENGTH).value,
      selectorConfidence: 'fallback'
    };
  }

  function collectAttributes(element) {
    var attributes = {};

    for (var index = 0; index < ATTRIBUTE_ALLOWLIST.length; index += 1) {
      var attributeName = ATTRIBUTE_ALLOWLIST[index];
      var attributeValue = element.getAttribute(attributeName);
      if (attributeValue == null) continue;

      attributes[attributeName] = sanitizeAndTruncate(attributeValue, MAX_ATTRIBUTE_VALUE_LENGTH).value;
    }

    return attributes;
  }

  function getSafeTextContent(element) {
    // TreeWalker that rejects form-control, datalist, output, and contenteditable
    // subtrees so descendant values don't leak into the captured text.
    var result = '';
    var walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_ALL,
      {
        acceptNode: function(node) {
          if (node.nodeType === 1) {
            var tag = node.tagName.toLowerCase();
            if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'datalist' || tag === 'output') {
              return NodeFilter.FILTER_REJECT;
            }
            // Skip contenteditable subtrees
            if (node.isContentEditable) {
              return NodeFilter.FILTER_REJECT;
            }
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      }
    );
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) {
        result += node.textContent;
      }
    }
    return result;
  }

  function captureElementPayload(element) {
    var rect = element.getBoundingClientRect();
    var selectorInfo = generateSelector(element);
    var textResult = sanitizeAndTruncate(getSafeTextContent(element), MAX_TEXT_CONTENT_LENGTH);

    return {
      tabId: window.__termul_annotation_tab_id || '',
      url: stripControlChars(location.href),
      title: stripControlChars(document.title || ''),
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      tagName: stripControlChars(element.tagName.toLowerCase()),
      selector: selectorInfo.selector,
      selectorConfidence: selectorInfo.selectorConfidence,
      attributes: collectAttributes(element),
      textContent: textResult.value,
      textTruncated: textResult.truncated,
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height
    };
  }

  function onMouseDown(e) {
    if (mode !== 'draw') return;
    if (!e.isTrusted) return;
    if (e.button !== 0) return;

    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;

    rectEl = document.createElement('div');
    rectEl.id = RECT_ID;
    rectEl.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px dashed #3b82f6;background:rgba(59,130,246,0.15);';
    rectEl.style.left = startX + 'px';
    rectEl.style.top = startY + 'px';
    rectEl.style.width = '0px';
    rectEl.style.height = '0px';
    document.body.appendChild(rectEl);
  }

  function onMouseMove(e) {
    if (mode === 'draw') {
      if (!e.isTrusted) return;
      if (!isDragging || !rectEl) return;

      var currentX = e.clientX;
      var currentY = e.clientY;
      var x = Math.min(startX, currentX);
      var y = Math.min(startY, currentY);
      var width = Math.abs(currentX - startX);
      var height = Math.abs(currentY - startY);
      rectEl.style.left = x + 'px';
      rectEl.style.top = y + 'px';
      rectEl.style.width = width + 'px';
      rectEl.style.height = height + 'px';
      return;
    }

    var resolvedElement = resolveElementAtPoint(e.clientX, e.clientY);
    if (!resolvedElement || isSensitiveElement(resolvedElement) || !hasVisibleBounds(resolvedElement)) {
      clearTrackedElement();
      return;
    }

    setTrackedElement(resolvedElement);
  }

  function onMouseUp(e) {
    if (mode !== 'draw') return;
    if (!e.isTrusted) return;
    if (!isDragging) return;
    isDragging = false;

    if (!rectEl) return;

    var currentX = e.clientX;
    var currentY = e.clientY;
    var width = Math.abs(currentX - startX);
    var height = Math.abs(currentY - startY);

    if (width > 0 && height > 0) {
      var x = Math.min(startX, currentX);
      var y = Math.min(startY, currentY);
      invoke('browser_tab_report_region_captured', {
        tabId: window.__termul_annotation_tab_id || '',
        x: x,
        y: y,
        width: width,
        height: height,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight
      });
    }

    rectEl.remove();
    rectEl = null;
  }

  function onClick(e) {
    if (mode !== 'select') return;
    if (!e.isTrusted) return;
    if (typeof e.button === 'number' && e.button !== 0) return;

    var target = trackedElement || resolveElementAtPoint(e.clientX, e.clientY);
    if (!target) return;
    if (isOverlayElement(target)) return;
    if (isMarkerElement(target)) return;
    if (target === document.documentElement || target === document.body) return;
    if (!document.contains(target)) return;
    if (!hasVisibleBounds(target)) return;
    if (isSensitiveElement(target)) return;

    e.preventDefault();
    e.stopPropagation();
    if (typeof e.stopImmediatePropagation === 'function') {
      e.stopImmediatePropagation();
    }

    invoke('browser_tab_report_element_captured', captureElementPayload(target));
  }

  function onKeyDown(e) {
    if (e.key === 'Escape' && isDragging) {
      isDragging = false;
      if (rectEl) {
        rectEl.remove();
        rectEl = null;
      }
    }
  }

  function onContextMenu(e) {
    if (mode !== 'draw') return;
    e.preventDefault();
    e.stopPropagation();
  }

  // --- Marker System ---
  var MARKER_CONTAINER_ID = '__termul_marker_container';
  var MARKER_CLASS = '__termul_marker';
  var markerContainer = null;
  var markerRegistry = {};
  var markerRafId = 0;

  function isMarkerElement(element) {
    return !!(element && element.classList && element.classList.contains(MARKER_CLASS));
  }

  function stopMarkerTracking() {
    if (markerRafId) {
      cancelAnimationFrame(markerRafId);
      markerRafId = 0;
    }
  }

  function isOffScreen(rect) {
    return rect.bottom < 0 || rect.top > window.innerHeight || rect.right < 0 || rect.left > window.innerWidth;
  }

  function updateMarkerPositions() {
    markerRafId = 0;
    var hasVisible = false;

    for (var id in markerRegistry) {
      if (!markerRegistry.hasOwnProperty(id)) continue;
      var entry = markerRegistry[id];
      var markerEl = entry.element;
      var data = entry.data;

      if (data.type === 'element') {
        if (!data.selector) {
          markerEl.style.display = 'none';
          continue;
        }
        try {
          var resolved = document.querySelector(data.selector);
          if (!resolved || !document.contains(resolved)) {
            markerEl.style.display = 'none';
            continue;
          }
          var rect = resolved.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0 || isOffScreen(rect)) {
            markerEl.style.display = 'none';
            continue;
          }
          // Safety: if resolved element's rect is far from captured boundingBox, hide marker
          var bbox = data.boundingBox;
          if (bbox) {
            var dx = Math.abs(rect.left - bbox.x);
            var dy = Math.abs(rect.top - bbox.y);
            var dw = Math.abs(rect.width - bbox.width);
            var dh = Math.abs(rect.height - bbox.height);
            if (dx > 50 || dy > 50 || dw > 50 || dh > 50) {
              markerEl.style.display = 'none';
              continue;
            }
          }
          markerEl.style.left = rect.left + 'px';
          markerEl.style.top = rect.top + 'px';
          markerEl.style.display = 'block';
          hasVisible = true;
        } catch (err) {
          markerEl.style.display = 'none';
        }
      } else if (data.type === 'region') {
        var regionRect = { left: data.x, top: data.y, right: data.x + 16, bottom: data.y + 16 };
        if (isOffScreen(regionRect)) {
          markerEl.style.display = 'none';
        } else {
          markerEl.style.left = data.x + 'px';
          markerEl.style.top = data.y + 'px';
          markerEl.style.display = 'block';
          hasVisible = true;
        }
      }
    }

    if (Object.keys(markerRegistry).length > 0) {
      markerRafId = requestAnimationFrame(updateMarkerPositions);
    }
  }

  function startMarkerTracking() {
    if (markerRafId) return;
    markerRafId = requestAnimationFrame(updateMarkerPositions);
  }

  function ensureMarkerContainer() {
    if (markerContainer) return markerContainer;
    markerContainer = document.createElement('div');
    markerContainer.id = MARKER_CONTAINER_ID;
    markerContainer.style.cssText = [
      'position:fixed',
      'top:0',
      'left:0',
      'width:100vw',
      'height:100vh',
      'z-index:2147483646',
      'pointer-events:none'
    ].join(';');
    document.body.appendChild(markerContainer);
    return markerContainer;
  }

  function createMarkerElement(data, selectedId) {
    var el = document.createElement('div');
    el.className = MARKER_CLASS;
    el.dataset.annotationId = data.id;
    el.style.cssText = [
      'position:absolute',
      'width:16px',
      'height:16px',
      'border-radius:50%',
      'border:2px solid #3b82f6',
      'background:transparent',
      'pointer-events:auto',
      'cursor:pointer',
      'box-sizing:border-box'
    ].join(';');

    if (data.id === selectedId) {
      el.classList.add('__termul_marker_selected');
    }

    el.addEventListener('click', function onMarkerClick(e) {
      if (typeof e.button === 'number' && e.button !== 0) return;
      e.stopPropagation();
      e.stopImmediatePropagation();
      invoke('browser_tab_report_annotation_marker_clicked', {
        tabId: window.__termul_annotation_tab_id || '',
        annotationId: data.id
      });
    });

    return el;
  }

  // Inject marker styling once
  if (!document.getElementById('__termul_marker_styles')) {
    var style = document.createElement('style');
    style.id = '__termul_marker_styles';
    style.textContent = [
      '.' + MARKER_CLASS + ' {',
      '  transition: transform 0.15s ease, background 0.1s ease, border-color 0.1s ease;',
      '}',
      '.' + MARKER_CLASS + '.__termul_marker_selected {',
      '  background: #3b82f6;',
      '  border-color: #ffffff;',
      '  transform: scale(1.2);',
      '  box-shadow: 0 0 6px rgba(59, 130, 246, 0.5);',
      '  z-index: 1;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .' + MARKER_CLASS + ' {',
      '    transition: none;',
      '  }',
      '  .' + MARKER_CLASS + '.__termul_marker_selected {',
      '    transform: scale(1);',
      '  }',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  window.__termul_render_markers = function(annotations, selectedId) {
    window.__termul_remove_markers();
    if (!annotations || annotations.length === 0) return;

    var container = ensureMarkerContainer();
    markerRegistry = {};
    var fragment = document.createDocumentFragment();

    for (var i = 0; i < annotations.length; i++) {
      var data = annotations[i];
      var markerEl = createMarkerElement(data, selectedId);
      markerEl.style.left = (data.x || 0) + 'px';
      markerEl.style.top = (data.y || 0) + 'px';
      fragment.appendChild(markerEl);
      markerRegistry[data.id] = { element: markerEl, data: data };
    }
    container.appendChild(fragment);

    startMarkerTracking();
  };

  window.__termul_update_marker_selection = function(selectedId) {
    if (!markerContainer) return;
    var markers = markerContainer.querySelectorAll('.' + MARKER_CLASS);
    for (var i = 0; i < markers.length; i++) {
      var m = markers[i];
      var isSelected = String(m.dataset.annotationId) === String(selectedId);
      if (isSelected) {
        m.classList.add('__termul_marker_selected');
      } else {
        m.classList.remove('__termul_marker_selected');
      }
    }
  };

  window.__termul_remove_markers = function() {
    stopMarkerTracking();
    if (markerContainer) {
      markerContainer.remove();
      markerContainer = null;
    }
    markerRegistry = {};
  };
  // --- End Marker System ---

  window.__termul_remove_annotation_overlay = function() {
    window.__termul_remove_markers();
    var markerStylesEl = document.getElementById('__termul_marker_styles');
    if (markerStylesEl) {
      markerStylesEl.remove();
    }
    overlay.remove();
    if (rectEl) {
      rectEl.remove();
      rectEl = null;
    }
    if (highlightEl) {
      highlightEl.remove();
      highlightEl = null;
    }
    trackedElement = null;
    stopHighlightTracking();
    document.removeEventListener('mousedown', onMouseDown, true);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('mouseup', onMouseUp, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('contextmenu', onContextMenu, true);
    document.documentElement.style.cursor = previousCursor;
    delete window.__termul_remove_annotation_overlay;
    delete window.__termul_annotation_tab_id;
    delete window.__termul_annotation_mode;
  };

  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('mousemove', onMouseMove, true);
  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('contextmenu', onContextMenu, true);

  document.body.appendChild(overlay);
})();
