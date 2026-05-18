/**
 * Copyright (c) 2014-2024 The xterm.js authors. All rights reserved.
 * @license MIT
 *
 * Copyright (c) 2012-2013, Christopher Jeffrey (MIT License)
 * @license MIT
 *
 * Originally forked from (with the author's permission):
 *   Fabrice Bellard's javascript vt100 for jslinux:
 *   http://bellard.org/jslinux/
 *   Copyright (c) 2011 Fabrice Bellard
 */function g(t){var e;return(e=t==null?void 0:t.ownerDocument)!=null&&e.defaultView?t.ownerDocument.defaultView:window}function o(t){return g(t).getComputedStyle(t,null)}var w=class{activate(t){this._terminal=t}dispose(){}fit(){let t=this.proposeDimensions();!t||!this._terminal||isNaN(t.cols)||isNaN(t.rows)||this._terminal.resize(t.cols,t.rows)}proposeDimensions(){var s,n;if(!this._terminal||!this._terminal.element||!this._terminal.element.parentElement)return;let t=this._terminal.dimensions;if(!t||t.css.cell.width===0||t.css.cell.height===0)return;let e=((s=this._terminal.options.scrollbar)==null?void 0:s.showScrollbar)??!0,a=this._terminal.options.scrollback===0||!e?0:((n=this._terminal.options.scrollbar)==null?void 0:n.width)??14,l=o(this._terminal.element.parentElement),h=parseInt(l.getPropertyValue("height")),p=Math.max(0,parseInt(l.getPropertyValue("width"))),r=o(this._terminal.element),i={top:parseInt(r.getPropertyValue("padding-top")),bottom:parseInt(r.getPropertyValue("padding-bottom")),right:parseInt(r.getPropertyValue("padding-right")),left:parseInt(r.getPropertyValue("padding-left"))},m=i.top+i.bottom,c=i.right+i.left,d=h-m,u=p-c-a;return{cols:Math.max(2,Math.floor(u/t.css.cell.width)),rows:Math.max(1,Math.floor(d/t.css.cell.height))}}};export{w as FitAddon};
