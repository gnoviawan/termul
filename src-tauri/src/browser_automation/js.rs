//! Page-side scripts for the eval bridge. All scripts are self-contained
//! IIFEs evaluated via `webview.eval`; results post back through
//! `browser_agent_eval_result` (see `wrap_eval`).
//!
//! Ref model: `snapshot` registers interactive elements as `@eN` in
//! `window.__termulBrowserRefs` with a structural `sel` fingerprint +
//! role/name, and stamps results with the page-local epoch captured at call
//! time. `resolve_ref` re-queries the fingerprint so a navigated/rebuilt DOM
//! surfaces as `stale_ref` instead of clicking the wrong node.

use serde_json::Value;

/// Wrap `expr` so its completion value posts back via the tab-scoped result
/// command. The expression runs in the page main world; `__TAURI_INTERNALS__`
/// is present in every Termul child webview (same mechanism the URL poller
/// uses). Returns the full script string for `webview.eval`.
pub fn wrap_eval(tab_id: &str, nonce: &str, expr: &str) -> String {
    let tab = serde_json::to_string(tab_id).unwrap_or_else(|_| "\"\"".into());
    let n = serde_json::to_string(nonce).unwrap_or_else(|_| "\"\"".into());
    format!(
        r#"(function(){{
  var __done=function(ok,val){{try{{
    var inv=null;
    if(window.__TAURI_INTERNALS__&&window.__TAURI_INTERNALS__.invoke)inv=window.__TAURI_INTERNALS__.invoke;
    else if(window.__TAURI__&&window.__TAURI__.invoke)inv=window.__TAURI__.invoke;
    else if(window.__TAURI__&&window.__TAURI__.core&&window.__TAURI__.core.invoke)inv=window.__TAURI__.core.invoke;
    if(inv){{inv('browser_agent_eval_result',{{tabId:{tab},nonce:{n},ok:ok,value:JSON.stringify(val===undefined?null:val)}}).catch(function(){{}});return;}}
  }}catch(e){{}}}};
  try{{
    var __r=(function(){{ return ({expr}); }})();
    Promise.resolve(__r).then(function(v){{__done(true,v)}},function(e){{__done(false,String(e&&e.message||e))}});
  }}catch(e){{__done(false,String(e&&e.message||e))}}
}})();"#
    )
}

/// Shared prelude installed on demand: ref registry + helpers. Idempotent —
/// `__termulBrowser` is created once per document.
const PRELUDE: &str = r#"
if (!window.__termulBrowser) {
  window.__termulBrowser = (function () {
    var INTERACTIVE =
      'a[href],button,input,select,textarea,summary,' +
      '[role=button],[role=link],[role=textbox],[role=checkbox],[role=switch],[role=combobox],[role=listbox],[role=menuitem],[role=tab],[role=slider],[role=searchbox],' +
      '[contenteditable=true],[contenteditable=""],[onclick],[tabindex]';
    var TAG_ROLE = {
      A: 'link', BUTTON: 'button', INPUT: 'textbox', SELECT: 'combobox',
      TEXTAREA: 'textbox', SUMMARY: 'button', H1: 'heading', H2: 'heading',
      H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading',
      NAV: 'navigation', MAIN: 'main', ASIDE: 'complementary',
      HEADER: 'banner', FOOTER: 'contentinfo', FORM: 'form', IMG: 'img',
      UL: 'list', OL: 'list', LI: 'listitem', TABLE: 'table'
    };
    function roleOf(el) {
      var r = el.getAttribute('role');
      if (r) return r;
      if (el.tagName === 'INPUT') {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        if (t === 'checkbox') return 'checkbox';
        if (t === 'radio') return 'radio';
        if (t === 'submit' || t === 'button') return 'button';
        if (t === 'search') return 'searchbox';
        return 'textbox';
      }
      return TAG_ROLE[el.tagName] || '';
    }
    function nameOf(el) {
      var raw = el.getAttribute('aria-label') ||
        (el.getAttribute('aria-labelledby') ? labelledText(el) : '') ||
        el.getAttribute('title') || el.getAttribute('placeholder') ||
        el.getAttribute('alt') || el.innerText || el.value || '';
      return String(raw).replace(/\s+/g, ' ').trim().slice(0, 100);
    }
    function labelledText(el) {
      var ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/);
      var out = '';
      for (var i = 0; i < ids.length; i++) {
        var t = document.getElementById(ids[i]);
        if (t) out += (t.innerText || '') + ' ';
      }
      return out.trim();
    }
    function visible(el) {
      if (!el.isConnected) return false;
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      var s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none';
    }
    function pathOf(el) {
      var segs = [];
      while (el && el.nodeType === 1 && el.tagName !== 'HTML') {
        var p = el.parentElement;
        if (!p) break;
        var same = Array.prototype.filter.call(p.children, function (c) {
          return c.tagName === el.tagName;
        });
        var idx = same.indexOf(el) + 1;
        segs.unshift(el.tagName.toLowerCase() + ':nth-of-type(' + idx + ')');
        el = p;
      }
      return 'html>' + segs.join('>');
    }
    function isInteractive(el) {
      try { return el.matches(INTERACTIVE); } catch (e) { return false; }
    }
    return {
      INTERACTIVE: INTERACTIVE, roleOf: roleOf, nameOf: nameOf,
      visible: visible, pathOf: pathOf, isInteractive: isInteractive,
      refs: {}, nextRef: 1, epoch: 0
    };
  })();
}
"#;

/// The aria-ish snapshot. Walks the DOM once; interactive elements get
/// `@eN` refs (fingerprint = structural selector + role + name); headings,
/// landmarks and text blocks become plain tree lines. Output bounded by the
/// caller (truncate in Rust).
pub const SNAPSHOT: &str = r#"(function(){
  PRELUDE
  var B = window.__termulBrowser;
  B.refs = {}; B.nextRef = 1;
  var lines = [];
  var MAX_LINES = 800;
  function emit(depth, text) { if (lines.length < MAX_LINES) lines.push('  '.repeat(depth) + text); }
  function walk(el, depth) {
    if (lines.length >= MAX_LINES || depth > 24) return;
    var tag = el.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') return;
    if (tag === 'IFRAME') { emit(depth, '- iframe'); return; }
    var role = B.roleOf(el), name = B.nameOf(el);
    var interactive = B.isInteractive(el) && B.visible(el);
    if (interactive) {
      var ref = '@e' + (B.nextRef++);
      B.refs[ref] = { sel: B.pathOf(el), role: role, name: name };
      var extra = '';
      if (el.tagName === 'A' && el.href) extra = ' ' + el.href;
      if (el.tagName === 'INPUT') {
        var t = (el.getAttribute('type') || 'text').toLowerCase();
        extra = ' type=' + t;
        if (t === 'checkbox' || t === 'radio') extra += el.checked ? ' checked' : ' unchecked';
      }
      emit(depth, '- ' + (role || tag.toLowerCase()) + ' "' + name + '" ' + ref + extra);
      return;
    }
    if (role === 'heading' || role === 'navigation' || role === 'main' || role === 'form' ||
        role === 'list' || role === 'listitem' || role === 'img' || role === 'table') {
      emit(depth, '- ' + role + (name ? ' "' + name + '"' : ''));
    } else if (['P','BLOCKQUOTE','PRE','TD','TH','LABEL','HGROUP','CAPTION','FIGCAPTION'].indexOf(tag) >= 0) {
      var t = name || (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      if (t) emit(depth, '- text "' + t + '"');
    }
    for (var i = 0; i < el.children.length; i++) walk(el.children[i], depth + 1);
  }
  walk(document.body || document.documentElement, 0);
  if (lines.length >= MAX_LINES) lines.push('…[snapshot line cap]');
  return {
    url: location.href, title: document.title || '',
    text: lines.join('\n'), refs: Object.keys(B.refs).length
  };
})()"#;

/// Build the snapshot script (PRELUDE + walker inline — one eval round-trip).
pub fn snapshot_script() -> String {
    SNAPSHOT.replace("PRELUDE", PRELUDE)
}

/// Resolve `@eN` → element existence + center rect. Epoch arg is the
/// Rust-side epoch at snapshot time — the page-side epoch is bumped by any
/// `browser_tab_report_url` hooking (history hooks + poller) via
/// `__termulBrowser.epoch++` performed in `mark_navigated`; here we also
/// verify the stored fingerprint still matches a re-query.
pub fn resolve_ref(ref_id: &str, epoch: u64) -> String {
    let r = serde_json::to_string(ref_id).unwrap_or_default();
    format!(
        r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  var fp=B.refs[{r}];
  if(!fp) return {{error:'stale_ref: {r} not in this document'}};
  var el;
  try{{ el=document.querySelector(fp.sel); }}catch(e){{ el=null; }}
  if(!el||!B.visible(el)) return {{error:'stale_ref: {r} detached'}};
  var role=B.roleOf(el), name=B.nameOf(el);
  if(role!==fp.role) return {{error:'stale_ref: {r} role changed'}};
  var rc=el.getBoundingClientRect();
  return {{epoch:{epoch}, rect:{{cx:rc.left+rc.width/2, cy:rc.top+rc.height/2, w:rc.width, h:rc.height}}, role:role, name:name}};
}})()"#
    )
}

/// JS fallback click (non-Windows engines): resolve, scroll into view,
/// synthesize pointer+click (not trusted, but functional everywhere).
pub fn dom_click(ref_id: &str, epoch: u64) -> String {
    let r = serde_json::to_string(ref_id).unwrap_or_default();
    format!(
        r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  var fp=B.refs[{r}];
  if(!fp) return {{error:'stale_ref: {r} not in this document'}};
  var el; try{{el=document.querySelector(fp.sel);}}catch(e){{el=null;}}
  if(!el||!B.visible(el)) return {{error:'stale_ref: {r} detached'}};
  el.scrollIntoView({{block:'center',inline:'center'}});
  var rc=el.getBoundingClientRect();
  var cx=rc.left+rc.width/2, cy=rc.top+rc.height/2;
  ['pointerdown','mousedown','pointerup','mouseup','click'].forEach(function(t){{
    el.dispatchEvent(new (t.indexOf('pointer')===0?PointerEvent:MouseEvent)(t,{{bubbles:true,cancelable:true,clientX:cx,clientY:cy,button:0}}));
  }});
  return {{epoch:{epoch}, ok:true}};
}})()"#
    )
}

/// Set a form element's value with input/change events (React-compatible
/// native setter trick).
pub fn fill_ref(ref_id: &str, value: &str, epoch: u64) -> String {
    let r = serde_json::to_string(ref_id).unwrap_or_default();
    let v = serde_json::to_string(value).unwrap_or_default();
    format!(
        r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  var fp=B.refs[{r}];
  if(!fp) return {{error:'stale_ref: {r} not in this document'}};
  var el; try{{el=document.querySelector(fp.sel);}}catch(e){{el=null;}}
  if(!el||!B.visible(el)) return {{error:'stale_ref: {r} detached'}};
  el.focus();
  if(el.isContentEditable){{ el.textContent={v}; el.dispatchEvent(new InputEvent('input',{{bubbles:true,inputType:'insertText',data:{v}}})); }}
  else {{
    var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var setter=Object.getOwnPropertyDescriptor(proto,'value');
    if(el.tagName==='SELECT'){{ el.value={v}; }}
    else if(setter&&setter.set){{ setter.set.call(el,{v}); }} else {{ el.value={v}; }}
    el.dispatchEvent(new Event('input',{{bubbles:true}}));
    el.dispatchEvent(new Event('change',{{bubbles:true}}));
  }}
  return {{epoch:{epoch}, ok:true}};
}})()"#
    )
}

/// `type` (insert text into focused/resolved element), `press` (key event),
/// `scroll` (by delta or to a ref), `hover` (move over a ref).
pub fn interaction(action: &str, args: &Value, epoch: u64) -> String {
    let ref_part = args
        .get("ref")
        .and_then(Value::as_str)
        .map(|r| serde_json::to_string(r).unwrap_or_default())
        .unwrap_or_else(|| "null".into());
    match action {
        "type" => {
            let text =
                serde_json::to_string(args.get("text").and_then(Value::as_str).unwrap_or_default())
                    .unwrap_or_default();
            format!(
                r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  var el=document.activeElement;
  if({ref_part}){{
    var fp=B.refs[{ref_part}];
    if(!fp) return {{error:'stale_ref'}};
    el=document.querySelector(fp.sel);
    if(!el||!B.visible(el)) return {{error:'stale_ref: detached'}};
    el.focus();
  }}
  if(!el||el===document.body) return {{error:'no focused element'}};
  if(el.isContentEditable){{ el.textContent=(el.textContent||'')+{text}; }}
  else {{ var proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    var setter=proto&&Object.getOwnPropertyDescriptor(proto,'value');
    var cur=el.value||'';
    if(setter&&setter.set) setter.set.call(el,cur+{text}); else el.value=cur+{text}; }}
  el.dispatchEvent(new Event('input',{{bubbles:true}}));
  el.dispatchEvent(new Event('change',{{bubbles:true}}));
  return {{epoch:{epoch}, ok:true}};
}})()"#
            )
        }
        "press" => {
            let key =
                serde_json::to_string(args.get("key").and_then(Value::as_str).unwrap_or("Enter"))
                    .unwrap_or_default();
            format!(
                r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  var el=document.activeElement&&document.activeElement!==document.body?document.activeElement:null;
  if({ref_part}){{
    var fp=B.refs[{ref_part}];
    if(!fp) return {{error:'stale_ref'}};
    el=document.querySelector(fp.sel);
    if(!el) return {{error:'stale_ref: detached'}};
    el.focus();
  }}
  if(!el) el=document.body;
  var key={key};
  ['keydown','keypress','keyup'].forEach(function(t){{
    el.dispatchEvent(new KeyboardEvent(t,{{key:key,bubbles:true,cancelable:true}}));
  }});
  if(key==='Enter'&&el.tagName==='BUTTON') el.click();
  return {{epoch:{epoch}, ok:true}};
}})()"#
            )
        }
        "scroll" => {
            let dy = args.get("dy").and_then(Value::as_f64).unwrap_or(600.0);
            format!(
                r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  if({ref_part}){{
    var fp=B.refs[{ref_part}];
    if(!fp) return {{error:'stale_ref'}};
    var el=document.querySelector(fp.sel);
    if(!el) return {{error:'stale_ref: detached'}};
    el.scrollIntoView({{block:'center',inline:'center'}});
  }} else {{ window.scrollBy(0,{dy}); }}
  return {{epoch:{epoch}, ok:true}};
}})()"#
            )
        }
        _ => {
            // hover
            format!(
                r#"(function(){{
  {PRELUDE}
  var B=window.__termulBrowser;
  var fp=B.refs[{ref_part}];
  if(!fp) return {{error:'stale_ref'}};
  var el=document.querySelector(fp.sel);
  if(!el) return {{error:'stale_ref: detached'}};
  var rc=el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent('pointerover',{{bubbles:true,clientX:rc.left+rc.width/2,clientY:rc.top+rc.height/2}}));
  el.dispatchEvent(new MouseEvent('mouseover',{{bubbles:true,clientX:rc.left+rc.width/2,clientY:rc.top+rc.height/2}}));
  return {{epoch:{epoch}, ok:true}};
}})()"#
            )
        }
    }
}

/// Text-presence probe for `wait{text}`.
pub fn contains_text(text: &str) -> String {
    let t = serde_json::to_string(text).unwrap_or_default();
    format!(
        r#"(function(){{ var t={t}; return (document.body&&document.body.innerText||'').indexOf(t)>=0; }})()"#
    )
}
