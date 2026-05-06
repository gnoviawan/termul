(function() {
  // DOM-based guard survives SPA navigations (window object may persist but DOM is new)
  if (document.getElementById('__termul_annotation_layer')) return;

  const OVERLAY_ID = '__termul_annotation_layer';
  const RECT_ID = '__termul_annotation_rect';

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;cursor:crosshair;pointer-events:auto;';

  let startX = 0;
  let startY = 0;
  let rectEl = null;
  let isDragging = false;

  function invoke(cmd, args) {
    try {
      if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
        window.__TAURI_INTERNALS__.invoke(cmd, args);
        return true;
      }
    } catch(e) {}
    try {
      if (window.__TAURI__ && window.__TAURI__.invoke) {
        window.__TAURI__.invoke(cmd, args);
        return true;
      }
    } catch(e) {}
    try {
      if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke(cmd, args);
        return true;
      }
    } catch(e) {}
    return false;
  }

  function onMouseDown(e) {
    // Left click only
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
    if (!isDragging || !rectEl) return;
    const currentX = e.clientX;
    const currentY = e.clientY;
    const x = Math.min(startX, currentX);
    const y = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    rectEl.style.left = x + 'px';
    rectEl.style.top = y + 'px';
    rectEl.style.width = width + 'px';
    rectEl.style.height = height + 'px';
  }

  function onMouseUp(e) {
    if (!isDragging) return;
    isDragging = false;

    if (!rectEl) return;

    const currentX = e.clientX;
    const currentY = e.clientY;
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);

    // Discard zero-area drags
    if (width > 0 && height > 0) {
      const x = Math.min(startX, currentX);
      const y = Math.min(startY, currentY);
      invoke('browser_tab_report_region_captured', {
        tabId: window.__termul_annotation_tab_id || '',
        x: x,
        y: y,
        width: width,
        height: height
      });
    }

    rectEl.remove();
    rectEl = null;
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
    e.preventDefault();
    e.stopPropagation();
  }

  // Expose cleanup globally so remove_annotation_overlay can call it
  window.__termul_remove_annotation_overlay = function() {
    overlay.remove();
    if (rectEl) {
      rectEl.remove();
      rectEl = null;
    }
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('contextmenu', onContextMenu);
    delete window.__termul_remove_annotation_overlay;
    delete window.__termul_annotation_tab_id;
  };

  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('contextmenu', onContextMenu);

  document.body.appendChild(overlay);
})();
