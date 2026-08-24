"use strict";var AgentationToolbar=(()=>{var gm=Object.create;var u_=Object.defineProperty;var ym=Object.getOwnPropertyDescriptor;var xm=Object.getOwnPropertyNames;var vm=Object.getPrototypeOf,wm=Object.prototype.hasOwnProperty;var vo=(e,t)=>()=>{try{return t||e((t={exports:{}}).exports,t),t.exports}catch(n){throw t=0,n}};var bm=(e,t,n,o)=>{if(t&&typeof t=="object"||typeof t=="function")for(let r of xm(t))!wm.call(e,r)&&r!==n&&u_(e,r,{get:()=>t[r],enumerable:!(o=ym(t,r))||o.enumerable});return e};var _t=(e,t,n)=>(n=e!=null?gm(vm(e)):{},bm(t||!e||!e.__esModule?u_(n,"default",{value:e,enumerable:!0}):n,e));var k_=vo(Ae=>{"use strict";var Bl=Symbol.for("react.element"),km=Symbol.for("react.portal"),Cm=Symbol.for("react.fragment"),Sm=Symbol.for("react.strict_mode"),Mm=Symbol.for("react.profiler"),Em=Symbol.for("react.provider"),Lm=Symbol.for("react.context"),Im=Symbol.for("react.forward_ref"),Nm=Symbol.for("react.suspense"),$m=Symbol.for("react.memo"),Rm=Symbol.for("react.lazy"),__=Symbol.iterator;function Tm(e){return e===null||typeof e!="object"?null:(e=__&&e[__]||e["@@iterator"],typeof e=="function"?e:null)}var p_={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},m_=Object.assign,g_={};function Fr(e,t,n){this.props=e,this.context=t,this.refs=g_,this.updater=n||p_}Fr.prototype.isReactComponent={};Fr.prototype.setState=function(e,t){if(typeof e!="object"&&typeof e!="function"&&e!=null)throw Error("setState(...): takes an object of state variables to update or a function which returns an object of state variables.");this.updater.enqueueSetState(this,e,t,"setState")};Fr.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,"forceUpdate")};function y_(){}y_.prototype=Fr.prototype;function qa(e,t,n){this.props=e,this.context=t,this.refs=g_,this.updater=n||p_}var Za=qa.prototype=new y_;Za.constructor=qa;m_(Za,Fr.prototype);Za.isPureReactComponent=!0;var f_=Array.isArray,x_=Object.prototype.hasOwnProperty,Ja={current:null},v_={key:!0,ref:!0,__self:!0,__source:!0};function w_(e,t,n){var o,r={},l=null,i=null;if(t!=null)for(o in t.ref!==void 0&&(i=t.ref),t.key!==void 0&&(l=""+t.key),t)x_.call(t,o)&&!v_.hasOwnProperty(o)&&(r[o]=t[o]);var s=arguments.length-2;if(s===1)r.children=n;else if(1<s){for(var a=Array(s),m=0;m<s;m++)a[m]=arguments[m+2];r.children=a}if(e&&e.defaultProps)for(o in s=e.defaultProps,s)r[o]===void 0&&(r[o]=s[o]);return{$$typeof:Bl,type:e,key:l,ref:i,props:r,_owner:Ja.current}}function Pm(e,t){return{$$typeof:Bl,type:e.type,key:t,ref:e.ref,props:e.props,_owner:e._owner}}function ec(e){return typeof e=="object"&&e!==null&&e.$$typeof===Bl}function Dm(e){var t={"=":"=0",":":"=2"};return"$"+e.replace(/[=:]/g,function(n){return t[n]})}var h_=/\/+/g;function Ga(e,t){return typeof e=="object"&&e!==null&&e.key!=null?Dm(""+e.key):t.toString(36)}function Gi(e,t,n,o,r){var l=typeof e;(l==="undefined"||l==="boolean")&&(e=null);var i=!1;if(e===null)i=!0;else switch(l){case"string":case"number":i=!0;break;case"object":switch(e.$$typeof){case Bl:case km:i=!0}}if(i)return i=e,r=r(i),e=o===""?"."+Ga(i,0):o,f_(r)?(n="",e!=null&&(n=e.replace(h_,"$&/")+"/"),Gi(r,t,n,"",function(m){return m})):r!=null&&(ec(r)&&(r=Pm(r,n+(!r.key||i&&i.key===r.key?"":(""+r.key).replace(h_,"$&/")+"/")+e)),t.push(r)),1;if(i=0,o=o===""?".":o+":",f_(e))for(var s=0;s<e.length;s++){l=e[s];var a=o+Ga(l,s);i+=Gi(l,t,n,a,r)}else if(a=Tm(e),typeof a=="function")for(e=a.call(e),s=0;!(l=e.next()).done;)l=l.value,a=o+Ga(l,s++),i+=Gi(l,t,n,a,r);else if(l==="object")throw t=String(e),Error("Objects are not valid as a React child (found: "+(t==="[object Object]"?"object with keys {"+Object.keys(e).join(", ")+"}":t)+"). If you meant to render a collection of children, use an array instead.");return i}function Ki(e,t,n){if(e==null)return e;var o=[],r=0;return Gi(e,o,"","",function(l){return t.call(n,l,r++)}),o}function Bm(e){if(e._status===-1){var t=e._result;t=t(),t.then(function(n){(e._status===0||e._status===-1)&&(e._status=1,e._result=n)},function(n){(e._status===0||e._status===-1)&&(e._status=2,e._result=n)}),e._status===-1&&(e._status=0,e._result=t)}if(e._status===1)return e._result.default;throw e._result}var tn={current:null},qi={transition:null},zm={ReactCurrentDispatcher:tn,ReactCurrentBatchConfig:qi,ReactCurrentOwner:Ja};function b_(){throw Error("act(...) is not supported in production builds of React.")}Ae.Children={map:Ki,forEach:function(e,t,n){Ki(e,function(){t.apply(this,arguments)},n)},count:function(e){var t=0;return Ki(e,function(){t++}),t},toArray:function(e){return Ki(e,function(t){return t})||[]},only:function(e){if(!ec(e))throw Error("React.Children.only expected to receive a single React element child.");return e}};Ae.Component=Fr;Ae.Fragment=Cm;Ae.Profiler=Mm;Ae.PureComponent=qa;Ae.StrictMode=Sm;Ae.Suspense=Nm;Ae.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=zm;Ae.act=b_;Ae.cloneElement=function(e,t,n){if(e==null)throw Error("React.cloneElement(...): The argument must be a React element, but you passed "+e+".");var o=m_({},e.props),r=e.key,l=e.ref,i=e._owner;if(t!=null){if(t.ref!==void 0&&(l=t.ref,i=Ja.current),t.key!==void 0&&(r=""+t.key),e.type&&e.type.defaultProps)var s=e.type.defaultProps;for(a in t)x_.call(t,a)&&!v_.hasOwnProperty(a)&&(o[a]=t[a]===void 0&&s!==void 0?s[a]:t[a])}var a=arguments.length-2;if(a===1)o.children=n;else if(1<a){s=Array(a);for(var m=0;m<a;m++)s[m]=arguments[m+2];o.children=s}return{$$typeof:Bl,type:e.type,key:r,ref:l,props:o,_owner:i}};Ae.createContext=function(e){return e={$$typeof:Lm,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null,_defaultValue:null,_globalName:null},e.Provider={$$typeof:Em,_context:e},e.Consumer=e};Ae.createElement=w_;Ae.createFactory=function(e){var t=w_.bind(null,e);return t.type=e,t};Ae.createRef=function(){return{current:null}};Ae.forwardRef=function(e){return{$$typeof:Im,render:e}};Ae.isValidElement=ec;Ae.lazy=function(e){return{$$typeof:Rm,_payload:{_status:-1,_result:e},_init:Bm}};Ae.memo=function(e,t){return{$$typeof:$m,type:e,compare:t===void 0?null:t}};Ae.startTransition=function(e){var t=qi.transition;qi.transition={};try{e()}finally{qi.transition=t}};Ae.unstable_act=b_;Ae.useCallback=function(e,t){return tn.current.useCallback(e,t)};Ae.useContext=function(e){return tn.current.useContext(e)};Ae.useDebugValue=function(){};Ae.useDeferredValue=function(e){return tn.current.useDeferredValue(e)};Ae.useEffect=function(e,t){return tn.current.useEffect(e,t)};Ae.useId=function(){return tn.current.useId()};Ae.useImperativeHandle=function(e,t,n){return tn.current.useImperativeHandle(e,t,n)};Ae.useInsertionEffect=function(e,t){return tn.current.useInsertionEffect(e,t)};Ae.useLayoutEffect=function(e,t){return tn.current.useLayoutEffect(e,t)};Ae.useMemo=function(e,t){return tn.current.useMemo(e,t)};Ae.useReducer=function(e,t,n){return tn.current.useReducer(e,t,n)};Ae.useRef=function(e){return tn.current.useRef(e)};Ae.useState=function(e){return tn.current.useState(e)};Ae.useSyncExternalStore=function(e,t,n){return tn.current.useSyncExternalStore(e,t,n)};Ae.useTransition=function(){return tn.current.useTransition()};Ae.version="18.3.1"});var Nn=vo((vx,C_)=>{"use strict";C_.exports=k_()});var P_=vo(ft=>{"use strict";function rc(e,t){var n=e.length;e.push(t);e:for(;0<n;){var o=n-1>>>1,r=e[o];if(0<Zi(r,t))e[o]=t,e[n]=r,n=o;else break e}}function Yn(e){return e.length===0?null:e[0]}function es(e){if(e.length===0)return null;var t=e[0],n=e.pop();if(n!==t){e[0]=n;e:for(var o=0,r=e.length,l=r>>>1;o<l;){var i=2*(o+1)-1,s=e[i],a=i+1,m=e[a];if(0>Zi(s,n))a<r&&0>Zi(m,s)?(e[o]=m,e[a]=n,o=a):(e[o]=s,e[i]=n,o=i);else if(a<r&&0>Zi(m,n))e[o]=m,e[a]=n,o=a;else break e}}return t}function Zi(e,t){var n=e.sortIndex-t.sortIndex;return n!==0?n:e.id-t.id}typeof performance=="object"&&typeof performance.now=="function"?(S_=performance,ft.unstable_now=function(){return S_.now()}):(tc=Date,M_=tc.now(),ft.unstable_now=function(){return tc.now()-M_});var S_,tc,M_,so=[],Bo=[],Om=1,$n=null,Kt=3,ts=!1,_r=!1,Ol=!1,I_=typeof setTimeout=="function"?setTimeout:null,N_=typeof clearTimeout=="function"?clearTimeout:null,E_=typeof setImmediate<"u"?setImmediate:null;typeof navigator<"u"&&navigator.scheduling!==void 0&&navigator.scheduling.isInputPending!==void 0&&navigator.scheduling.isInputPending.bind(navigator.scheduling);function lc(e){for(var t=Yn(Bo);t!==null;){if(t.callback===null)es(Bo);else if(t.startTime<=e)es(Bo),t.sortIndex=t.expirationTime,rc(so,t);else break;t=Yn(Bo)}}function ic(e){if(Ol=!1,lc(e),!_r)if(Yn(so)!==null)_r=!0,ac(sc);else{var t=Yn(Bo);t!==null&&cc(ic,t.startTime-e)}}function sc(e,t){_r=!1,Ol&&(Ol=!1,N_(Al),Al=-1),ts=!0;var n=Kt;try{for(lc(t),$n=Yn(so);$n!==null&&(!($n.expirationTime>t)||e&&!T_());){var o=$n.callback;if(typeof o=="function"){$n.callback=null,Kt=$n.priorityLevel;var r=o($n.expirationTime<=t);t=ft.unstable_now(),typeof r=="function"?$n.callback=r:$n===Yn(so)&&es(so),lc(t)}else es(so);$n=Yn(so)}if($n!==null)var l=!0;else{var i=Yn(Bo);i!==null&&cc(ic,i.startTime-t),l=!1}return l}finally{$n=null,Kt=n,ts=!1}}var ns=!1,Ji=null,Al=-1,$_=5,R_=-1;function T_(){return!(ft.unstable_now()-R_<$_)}function nc(){if(Ji!==null){var e=ft.unstable_now();R_=e;var t=!0;try{t=Ji(!0,e)}finally{t?zl():(ns=!1,Ji=null)}}else ns=!1}var zl;typeof E_=="function"?zl=function(){E_(nc)}:typeof MessageChannel<"u"?(oc=new MessageChannel,L_=oc.port2,oc.port1.onmessage=nc,zl=function(){L_.postMessage(null)}):zl=function(){I_(nc,0)};var oc,L_;function ac(e){Ji=e,ns||(ns=!0,zl())}function cc(e,t){Al=I_(function(){e(ft.unstable_now())},t)}ft.unstable_IdlePriority=5;ft.unstable_ImmediatePriority=1;ft.unstable_LowPriority=4;ft.unstable_NormalPriority=3;ft.unstable_Profiling=null;ft.unstable_UserBlockingPriority=2;ft.unstable_cancelCallback=function(e){e.callback=null};ft.unstable_continueExecution=function(){_r||ts||(_r=!0,ac(sc))};ft.unstable_forceFrameRate=function(e){0>e||125<e?console.error("forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported"):$_=0<e?Math.floor(1e3/e):5};ft.unstable_getCurrentPriorityLevel=function(){return Kt};ft.unstable_getFirstCallbackNode=function(){return Yn(so)};ft.unstable_next=function(e){switch(Kt){case 1:case 2:case 3:var t=3;break;default:t=Kt}var n=Kt;Kt=t;try{return e()}finally{Kt=n}};ft.unstable_pauseExecution=function(){};ft.unstable_requestPaint=function(){};ft.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var n=Kt;Kt=e;try{return t()}finally{Kt=n}};ft.unstable_scheduleCallback=function(e,t,n){var o=ft.unstable_now();switch(typeof n=="object"&&n!==null?(n=n.delay,n=typeof n=="number"&&0<n?o+n:o):n=o,e){case 1:var r=-1;break;case 2:r=250;break;case 5:r=1073741823;break;case 4:r=1e4;break;default:r=5e3}return r=n+r,e={id:Om++,callback:t,priorityLevel:e,startTime:n,expirationTime:r,sortIndex:-1},n>o?(e.sortIndex=n,rc(Bo,e),Yn(so)===null&&e===Yn(Bo)&&(Ol?(N_(Al),Al=-1):Ol=!0,cc(ic,n-o))):(e.sortIndex=r,rc(so,e),_r||ts||(_r=!0,ac(sc))),e};ft.unstable_shouldYield=T_;ft.unstable_wrapCallback=function(e){var t=Kt;return function(){var n=Kt;Kt=t;try{return e.apply(this,arguments)}finally{Kt=n}}}});var B_=vo((bx,D_)=>{"use strict";D_.exports=P_()});var Fh=vo(kn=>{"use strict";var Am=Nn(),wn=B_();function j(e){for(var t="https://reactjs.org/docs/error-decoder.html?invariant="+e,n=1;n<arguments.length;n++)t+="&args[]="+encodeURIComponent(arguments[n]);return"Minified React error #"+e+"; visit "+t+" for the full message or use the non-minified dev environment for full errors and additional helpful warnings."}var Uf=new Set,si={};function Sr(e,t){al(e,t),al(e+"Capture",t)}function al(e,t){for(si[e]=t,e=0;e<t.length;e++)Uf.add(t[e])}var Mo=!(typeof window>"u"||typeof window.document>"u"||typeof window.document.createElement>"u"),Rc=Object.prototype.hasOwnProperty,Wm=/^[:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD][:A-Z_a-z\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u02FF\u0370-\u037D\u037F-\u1FFF\u200C-\u200D\u2070-\u218F\u2C00-\u2FEF\u3001-\uD7FF\uF900-\uFDCF\uFDF0-\uFFFD\-.0-9\u00B7\u0300-\u036F\u203F-\u2040]*$/,z_={},O_={};function Fm(e){return Rc.call(O_,e)?!0:Rc.call(z_,e)?!1:Wm.test(e)?O_[e]=!0:(z_[e]=!0,!1)}function jm(e,t,n,o){if(n!==null&&n.type===0)return!1;switch(typeof t){case"function":case"symbol":return!0;case"boolean":return o?!1:n!==null?!n.acceptsBooleans:(e=e.toLowerCase().slice(0,5),e!=="data-"&&e!=="aria-");default:return!1}}function Hm(e,t,n,o){if(t===null||typeof t>"u"||jm(e,t,n,o))return!0;if(o)return!1;if(n!==null)switch(n.type){case 3:return!t;case 4:return t===!1;case 5:return isNaN(t);case 6:return isNaN(t)||1>t}return!1}function rn(e,t,n,o,r,l,i){this.acceptsBooleans=t===2||t===3||t===4,this.attributeName=o,this.attributeNamespace=r,this.mustUseProperty=n,this.propertyName=e,this.type=t,this.sanitizeURL=l,this.removeEmptyString=i}var Qt={};"children dangerouslySetInnerHTML defaultValue defaultChecked innerHTML suppressContentEditableWarning suppressHydrationWarning style".split(" ").forEach(function(e){Qt[e]=new rn(e,0,!1,e,null,!1,!1)});[["acceptCharset","accept-charset"],["className","class"],["htmlFor","for"],["httpEquiv","http-equiv"]].forEach(function(e){var t=e[0];Qt[t]=new rn(t,1,!1,e[1],null,!1,!1)});["contentEditable","draggable","spellCheck","value"].forEach(function(e){Qt[e]=new rn(e,2,!1,e.toLowerCase(),null,!1,!1)});["autoReverse","externalResourcesRequired","focusable","preserveAlpha"].forEach(function(e){Qt[e]=new rn(e,2,!1,e,null,!1,!1)});"allowFullScreen async autoFocus autoPlay controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden loop noModule noValidate open playsInline readOnly required reversed scoped seamless itemScope".split(" ").forEach(function(e){Qt[e]=new rn(e,3,!1,e.toLowerCase(),null,!1,!1)});["checked","multiple","muted","selected"].forEach(function(e){Qt[e]=new rn(e,3,!0,e,null,!1,!1)});["capture","download"].forEach(function(e){Qt[e]=new rn(e,4,!1,e,null,!1,!1)});["cols","rows","size","span"].forEach(function(e){Qt[e]=new rn(e,6,!1,e,null,!1,!1)});["rowSpan","start"].forEach(function(e){Qt[e]=new rn(e,5,!1,e.toLowerCase(),null,!1,!1)});var Cd=/[\-:]([a-z])/g;function Sd(e){return e[1].toUpperCase()}"accent-height alignment-baseline arabic-form baseline-shift cap-height clip-path clip-rule color-interpolation color-interpolation-filters color-profile color-rendering dominant-baseline enable-background fill-opacity fill-rule flood-color flood-opacity font-family font-size font-size-adjust font-stretch font-style font-variant font-weight glyph-name glyph-orientation-horizontal glyph-orientation-vertical horiz-adv-x horiz-origin-x image-rendering letter-spacing lighting-color marker-end marker-mid marker-start overline-position overline-thickness paint-order panose-1 pointer-events rendering-intent shape-rendering stop-color stop-opacity strikethrough-position strikethrough-thickness stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin stroke-miterlimit stroke-opacity stroke-width text-anchor text-decoration text-rendering underline-position underline-thickness unicode-bidi unicode-range units-per-em v-alphabetic v-hanging v-ideographic v-mathematical vector-effect vert-adv-y vert-origin-x vert-origin-y word-spacing writing-mode xmlns:xlink x-height".split(" ").forEach(function(e){var t=e.replace(Cd,Sd);Qt[t]=new rn(t,1,!1,e,null,!1,!1)});"xlink:actuate xlink:arcrole xlink:role xlink:show xlink:title xlink:type".split(" ").forEach(function(e){var t=e.replace(Cd,Sd);Qt[t]=new rn(t,1,!1,e,"http://www.w3.org/1999/xlink",!1,!1)});["xml:base","xml:lang","xml:space"].forEach(function(e){var t=e.replace(Cd,Sd);Qt[t]=new rn(t,1,!1,e,"http://www.w3.org/XML/1998/namespace",!1,!1)});["tabIndex","crossOrigin"].forEach(function(e){Qt[e]=new rn(e,1,!1,e.toLowerCase(),null,!1,!1)});Qt.xlinkHref=new rn("xlinkHref",1,!1,"xlink:href","http://www.w3.org/1999/xlink",!0,!1);["src","href","action","formAction"].forEach(function(e){Qt[e]=new rn(e,1,!1,e.toLowerCase(),null,!0,!0)});function Md(e,t,n,o){var r=Qt.hasOwnProperty(t)?Qt[t]:null;(r!==null?r.type!==0:o||!(2<t.length)||t[0]!=="o"&&t[0]!=="O"||t[1]!=="n"&&t[1]!=="N")&&(Hm(t,n,r,o)&&(n=null),o||r===null?Fm(t)&&(n===null?e.removeAttribute(t):e.setAttribute(t,""+n)):r.mustUseProperty?e[r.propertyName]=n===null?r.type===3?!1:"":n:(t=r.attributeName,o=r.attributeNamespace,n===null?e.removeAttribute(t):(r=r.type,n=r===3||r===4&&n===!0?"":""+n,o?e.setAttributeNS(o,t,n):e.setAttribute(t,n))))}var No=Am.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED,os=Symbol.for("react.element"),Ur=Symbol.for("react.portal"),Yr=Symbol.for("react.fragment"),Ed=Symbol.for("react.strict_mode"),Tc=Symbol.for("react.profiler"),Yf=Symbol.for("react.provider"),Xf=Symbol.for("react.context"),Ld=Symbol.for("react.forward_ref"),Pc=Symbol.for("react.suspense"),Dc=Symbol.for("react.suspense_list"),Id=Symbol.for("react.memo"),Oo=Symbol.for("react.lazy"),Qf=Symbol.for("react.offscreen"),A_=Symbol.iterator;function Wl(e){return e===null||typeof e!="object"?null:(e=A_&&e[A_]||e["@@iterator"],typeof e=="function"?e:null)}var kt=Object.assign,dc;function Vl(e){if(dc===void 0)try{throw Error()}catch(n){var t=n.stack.trim().match(/\n( *(at )?)/);dc=t&&t[1]||""}return`
`+dc+e}var uc=!1;function _c(e,t){if(!e||uc)return"";uc=!0;var n=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{if(t)if(t=function(){throw Error()},Object.defineProperty(t.prototype,"props",{set:function(){throw Error()}}),typeof Reflect=="object"&&Reflect.construct){try{Reflect.construct(t,[])}catch(m){var o=m}Reflect.construct(e,[],t)}else{try{t.call()}catch(m){o=m}e.call(t.prototype)}else{try{throw Error()}catch(m){o=m}e()}}catch(m){if(m&&o&&typeof m.stack=="string"){for(var r=m.stack.split(`
`),l=o.stack.split(`
`),i=r.length-1,s=l.length-1;1<=i&&0<=s&&r[i]!==l[s];)s--;for(;1<=i&&0<=s;i--,s--)if(r[i]!==l[s]){if(i!==1||s!==1)do if(i--,s--,0>s||r[i]!==l[s]){var a=`
`+r[i].replace(" at new "," at ");return e.displayName&&a.includes("<anonymous>")&&(a=a.replace("<anonymous>",e.displayName)),a}while(1<=i&&0<=s);break}}}finally{uc=!1,Error.prepareStackTrace=n}return(e=e?e.displayName||e.name:"")?Vl(e):""}function Um(e){switch(e.tag){case 5:return Vl(e.type);case 16:return Vl("Lazy");case 13:return Vl("Suspense");case 19:return Vl("SuspenseList");case 0:case 2:case 15:return e=_c(e.type,!1),e;case 11:return e=_c(e.type.render,!1),e;case 1:return e=_c(e.type,!0),e;default:return""}}function Bc(e){if(e==null)return null;if(typeof e=="function")return e.displayName||e.name||null;if(typeof e=="string")return e;switch(e){case Yr:return"Fragment";case Ur:return"Portal";case Tc:return"Profiler";case Ed:return"StrictMode";case Pc:return"Suspense";case Dc:return"SuspenseList"}if(typeof e=="object")switch(e.$$typeof){case Xf:return(e.displayName||"Context")+".Consumer";case Yf:return(e._context.displayName||"Context")+".Provider";case Ld:var t=e.render;return e=e.displayName,e||(e=t.displayName||t.name||"",e=e!==""?"ForwardRef("+e+")":"ForwardRef"),e;case Id:return t=e.displayName||null,t!==null?t:Bc(e.type)||"Memo";case Oo:t=e._payload,e=e._init;try{return Bc(e(t))}catch{}}return null}function Ym(e){var t=e.type;switch(e.tag){case 24:return"Cache";case 9:return(t.displayName||"Context")+".Consumer";case 10:return(t._context.displayName||"Context")+".Provider";case 18:return"DehydratedFragment";case 11:return e=t.render,e=e.displayName||e.name||"",t.displayName||(e!==""?"ForwardRef("+e+")":"ForwardRef");case 7:return"Fragment";case 5:return t;case 4:return"Portal";case 3:return"Root";case 6:return"Text";case 16:return Bc(t);case 8:return t===Ed?"StrictMode":"Mode";case 22:return"Offscreen";case 12:return"Profiler";case 21:return"Scope";case 13:return"Suspense";case 19:return"SuspenseList";case 25:return"TracingMarker";case 1:case 0:case 17:case 2:case 14:case 15:if(typeof t=="function")return t.displayName||t.name||null;if(typeof t=="string")return t}return null}function Zo(e){switch(typeof e){case"boolean":case"number":case"string":case"undefined":return e;case"object":return e;default:return""}}function Vf(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()==="input"&&(t==="checkbox"||t==="radio")}function Xm(e){var t=Vf(e)?"checked":"value",n=Object.getOwnPropertyDescriptor(e.constructor.prototype,t),o=""+e[t];if(!e.hasOwnProperty(t)&&typeof n<"u"&&typeof n.get=="function"&&typeof n.set=="function"){var r=n.get,l=n.set;return Object.defineProperty(e,t,{configurable:!0,get:function(){return r.call(this)},set:function(i){o=""+i,l.call(this,i)}}),Object.defineProperty(e,t,{enumerable:n.enumerable}),{getValue:function(){return o},setValue:function(i){o=""+i},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function rs(e){e._valueTracker||(e._valueTracker=Xm(e))}function Kf(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var n=t.getValue(),o="";return e&&(o=Vf(e)?e.checked?"true":"false":e.value),e=o,e!==n?(t.setValue(e),!0):!1}function Rs(e){if(e=e||(typeof document<"u"?document:void 0),typeof e>"u")return null;try{return e.activeElement||e.body}catch{return e.body}}function zc(e,t){var n=t.checked;return kt({},t,{defaultChecked:void 0,defaultValue:void 0,value:void 0,checked:n??e._wrapperState.initialChecked})}function W_(e,t){var n=t.defaultValue==null?"":t.defaultValue,o=t.checked!=null?t.checked:t.defaultChecked;n=Zo(t.value!=null?t.value:n),e._wrapperState={initialChecked:o,initialValue:n,controlled:t.type==="checkbox"||t.type==="radio"?t.checked!=null:t.value!=null}}function Gf(e,t){t=t.checked,t!=null&&Md(e,"checked",t,!1)}function Oc(e,t){Gf(e,t);var n=Zo(t.value),o=t.type;if(n!=null)o==="number"?(n===0&&e.value===""||e.value!=n)&&(e.value=""+n):e.value!==""+n&&(e.value=""+n);else if(o==="submit"||o==="reset"){e.removeAttribute("value");return}t.hasOwnProperty("value")?Ac(e,t.type,n):t.hasOwnProperty("defaultValue")&&Ac(e,t.type,Zo(t.defaultValue)),t.checked==null&&t.defaultChecked!=null&&(e.defaultChecked=!!t.defaultChecked)}function F_(e,t,n){if(t.hasOwnProperty("value")||t.hasOwnProperty("defaultValue")){var o=t.type;if(!(o!=="submit"&&o!=="reset"||t.value!==void 0&&t.value!==null))return;t=""+e._wrapperState.initialValue,n||t===e.value||(e.value=t),e.defaultValue=t}n=e.name,n!==""&&(e.name=""),e.defaultChecked=!!e._wrapperState.initialChecked,n!==""&&(e.name=n)}function Ac(e,t,n){(t!=="number"||Rs(e.ownerDocument)!==e)&&(n==null?e.defaultValue=""+e._wrapperState.initialValue:e.defaultValue!==""+n&&(e.defaultValue=""+n))}var Kl=Array.isArray;function nl(e,t,n,o){if(e=e.options,t){t={};for(var r=0;r<n.length;r++)t["$"+n[r]]=!0;for(n=0;n<e.length;n++)r=t.hasOwnProperty("$"+e[n].value),e[n].selected!==r&&(e[n].selected=r),r&&o&&(e[n].defaultSelected=!0)}else{for(n=""+Zo(n),t=null,r=0;r<e.length;r++){if(e[r].value===n){e[r].selected=!0,o&&(e[r].defaultSelected=!0);return}t!==null||e[r].disabled||(t=e[r])}t!==null&&(t.selected=!0)}}function Wc(e,t){if(t.dangerouslySetInnerHTML!=null)throw Error(j(91));return kt({},t,{value:void 0,defaultValue:void 0,children:""+e._wrapperState.initialValue})}function j_(e,t){var n=t.value;if(n==null){if(n=t.children,t=t.defaultValue,n!=null){if(t!=null)throw Error(j(92));if(Kl(n)){if(1<n.length)throw Error(j(93));n=n[0]}t=n}t==null&&(t=""),n=t}e._wrapperState={initialValue:Zo(n)}}function qf(e,t){var n=Zo(t.value),o=Zo(t.defaultValue);n!=null&&(n=""+n,n!==e.value&&(e.value=n),t.defaultValue==null&&e.defaultValue!==n&&(e.defaultValue=n)),o!=null&&(e.defaultValue=""+o)}function H_(e){var t=e.textContent;t===e._wrapperState.initialValue&&t!==""&&t!==null&&(e.value=t)}function Zf(e){switch(e){case"svg":return"http://www.w3.org/2000/svg";case"math":return"http://www.w3.org/1998/Math/MathML";default:return"http://www.w3.org/1999/xhtml"}}function Fc(e,t){return e==null||e==="http://www.w3.org/1999/xhtml"?Zf(t):e==="http://www.w3.org/2000/svg"&&t==="foreignObject"?"http://www.w3.org/1999/xhtml":e}var ls,Jf=(function(e){return typeof MSApp<"u"&&MSApp.execUnsafeLocalFunction?function(t,n,o,r){MSApp.execUnsafeLocalFunction(function(){return e(t,n,o,r)})}:e})(function(e,t){if(e.namespaceURI!=="http://www.w3.org/2000/svg"||"innerHTML"in e)e.innerHTML=t;else{for(ls=ls||document.createElement("div"),ls.innerHTML="<svg>"+t.valueOf().toString()+"</svg>",t=ls.firstChild;e.firstChild;)e.removeChild(e.firstChild);for(;t.firstChild;)e.appendChild(t.firstChild)}});function ai(e,t){if(t){var n=e.firstChild;if(n&&n===e.lastChild&&n.nodeType===3){n.nodeValue=t;return}}e.textContent=t}var Zl={animationIterationCount:!0,aspectRatio:!0,borderImageOutset:!0,borderImageSlice:!0,borderImageWidth:!0,boxFlex:!0,boxFlexGroup:!0,boxOrdinalGroup:!0,columnCount:!0,columns:!0,flex:!0,flexGrow:!0,flexPositive:!0,flexShrink:!0,flexNegative:!0,flexOrder:!0,gridArea:!0,gridRow:!0,gridRowEnd:!0,gridRowSpan:!0,gridRowStart:!0,gridColumn:!0,gridColumnEnd:!0,gridColumnSpan:!0,gridColumnStart:!0,fontWeight:!0,lineClamp:!0,lineHeight:!0,opacity:!0,order:!0,orphans:!0,tabSize:!0,widows:!0,zIndex:!0,zoom:!0,fillOpacity:!0,floodOpacity:!0,stopOpacity:!0,strokeDasharray:!0,strokeDashoffset:!0,strokeMiterlimit:!0,strokeOpacity:!0,strokeWidth:!0},Qm=["Webkit","ms","Moz","O"];Object.keys(Zl).forEach(function(e){Qm.forEach(function(t){t=t+e.charAt(0).toUpperCase()+e.substring(1),Zl[t]=Zl[e]})});function e0(e,t,n){return t==null||typeof t=="boolean"||t===""?"":n||typeof t!="number"||t===0||Zl.hasOwnProperty(e)&&Zl[e]?(""+t).trim():t+"px"}function t0(e,t){e=e.style;for(var n in t)if(t.hasOwnProperty(n)){var o=n.indexOf("--")===0,r=e0(n,t[n],o);n==="float"&&(n="cssFloat"),o?e.setProperty(n,r):e[n]=r}}var Vm=kt({menuitem:!0},{area:!0,base:!0,br:!0,col:!0,embed:!0,hr:!0,img:!0,input:!0,keygen:!0,link:!0,meta:!0,param:!0,source:!0,track:!0,wbr:!0});function jc(e,t){if(t){if(Vm[e]&&(t.children!=null||t.dangerouslySetInnerHTML!=null))throw Error(j(137,e));if(t.dangerouslySetInnerHTML!=null){if(t.children!=null)throw Error(j(60));if(typeof t.dangerouslySetInnerHTML!="object"||!("__html"in t.dangerouslySetInnerHTML))throw Error(j(61))}if(t.style!=null&&typeof t.style!="object")throw Error(j(62))}}function Hc(e,t){if(e.indexOf("-")===-1)return typeof t.is=="string";switch(e){case"annotation-xml":case"color-profile":case"font-face":case"font-face-src":case"font-face-uri":case"font-face-format":case"font-face-name":case"missing-glyph":return!1;default:return!0}}var Uc=null;function Nd(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}var Yc=null,ol=null,rl=null;function U_(e){if(e=Mi(e)){if(typeof Yc!="function")throw Error(j(280));var t=e.stateNode;t&&(t=ia(t),Yc(e.stateNode,e.type,t))}}function n0(e){ol?rl?rl.push(e):rl=[e]:ol=e}function o0(){if(ol){var e=ol,t=rl;if(rl=ol=null,U_(e),t)for(e=0;e<t.length;e++)U_(t[e])}}function r0(e,t){return e(t)}function l0(){}var fc=!1;function i0(e,t,n){if(fc)return e(t,n);fc=!0;try{return r0(e,t,n)}finally{fc=!1,(ol!==null||rl!==null)&&(l0(),o0())}}function ci(e,t){var n=e.stateNode;if(n===null)return null;var o=ia(n);if(o===null)return null;n=o[t];e:switch(t){case"onClick":case"onClickCapture":case"onDoubleClick":case"onDoubleClickCapture":case"onMouseDown":case"onMouseDownCapture":case"onMouseMove":case"onMouseMoveCapture":case"onMouseUp":case"onMouseUpCapture":case"onMouseEnter":(o=!o.disabled)||(e=e.type,o=!(e==="button"||e==="input"||e==="select"||e==="textarea")),e=!o;break e;default:e=!1}if(e)return null;if(n&&typeof n!="function")throw Error(j(231,t,typeof n));return n}var Xc=!1;if(Mo)try{jr={},Object.defineProperty(jr,"passive",{get:function(){Xc=!0}}),window.addEventListener("test",jr,jr),window.removeEventListener("test",jr,jr)}catch{Xc=!1}var jr;function Km(e,t,n,o,r,l,i,s,a){var m=Array.prototype.slice.call(arguments,3);try{t.apply(n,m)}catch(p){this.onError(p)}}var Jl=!1,Ts=null,Ps=!1,Qc=null,Gm={onError:function(e){Jl=!0,Ts=e}};function qm(e,t,n,o,r,l,i,s,a){Jl=!1,Ts=null,Km.apply(Gm,arguments)}function Zm(e,t,n,o,r,l,i,s,a){if(qm.apply(this,arguments),Jl){if(Jl){var m=Ts;Jl=!1,Ts=null}else throw Error(j(198));Ps||(Ps=!0,Qc=m)}}function Mr(e){var t=e,n=e;if(e.alternate)for(;t.return;)t=t.return;else{e=t;do t=e,(t.flags&4098)!==0&&(n=t.return),e=t.return;while(e)}return t.tag===3?n:null}function s0(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function Y_(e){if(Mr(e)!==e)throw Error(j(188))}function Jm(e){var t=e.alternate;if(!t){if(t=Mr(e),t===null)throw Error(j(188));return t!==e?null:e}for(var n=e,o=t;;){var r=n.return;if(r===null)break;var l=r.alternate;if(l===null){if(o=r.return,o!==null){n=o;continue}break}if(r.child===l.child){for(l=r.child;l;){if(l===n)return Y_(r),e;if(l===o)return Y_(r),t;l=l.sibling}throw Error(j(188))}if(n.return!==o.return)n=r,o=l;else{for(var i=!1,s=r.child;s;){if(s===n){i=!0,n=r,o=l;break}if(s===o){i=!0,o=r,n=l;break}s=s.sibling}if(!i){for(s=l.child;s;){if(s===n){i=!0,n=l,o=r;break}if(s===o){i=!0,o=l,n=r;break}s=s.sibling}if(!i)throw Error(j(189))}}if(n.alternate!==o)throw Error(j(190))}if(n.tag!==3)throw Error(j(188));return n.stateNode.current===n?e:t}function a0(e){return e=Jm(e),e!==null?c0(e):null}function c0(e){if(e.tag===5||e.tag===6)return e;for(e=e.child;e!==null;){var t=c0(e);if(t!==null)return t;e=e.sibling}return null}var d0=wn.unstable_scheduleCallback,X_=wn.unstable_cancelCallback,e1=wn.unstable_shouldYield,t1=wn.unstable_requestPaint,Rt=wn.unstable_now,n1=wn.unstable_getCurrentPriorityLevel,$d=wn.unstable_ImmediatePriority,u0=wn.unstable_UserBlockingPriority,Ds=wn.unstable_NormalPriority,o1=wn.unstable_LowPriority,_0=wn.unstable_IdlePriority,na=null,_o=null;function r1(e){if(_o&&typeof _o.onCommitFiberRoot=="function")try{_o.onCommitFiberRoot(na,e,void 0,(e.current.flags&128)===128)}catch{}}var Gn=Math.clz32?Math.clz32:s1,l1=Math.log,i1=Math.LN2;function s1(e){return e>>>=0,e===0?32:31-(l1(e)/i1|0)|0}var is=64,ss=4194304;function Gl(e){switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return e&4194240;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return e&130023424;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 1073741824;default:return e}}function Bs(e,t){var n=e.pendingLanes;if(n===0)return 0;var o=0,r=e.suspendedLanes,l=e.pingedLanes,i=n&268435455;if(i!==0){var s=i&~r;s!==0?o=Gl(s):(l&=i,l!==0&&(o=Gl(l)))}else i=n&~r,i!==0?o=Gl(i):l!==0&&(o=Gl(l));if(o===0)return 0;if(t!==0&&t!==o&&(t&r)===0&&(r=o&-o,l=t&-t,r>=l||r===16&&(l&4194240)!==0))return t;if((o&4)!==0&&(o|=n&16),t=e.entangledLanes,t!==0)for(e=e.entanglements,t&=o;0<t;)n=31-Gn(t),r=1<<n,o|=e[n],t&=~r;return o}function a1(e,t){switch(e){case 1:case 2:case 4:return t+250;case 8:case 16:case 32:case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5e3;case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:return-1;case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function c1(e,t){for(var n=e.suspendedLanes,o=e.pingedLanes,r=e.expirationTimes,l=e.pendingLanes;0<l;){var i=31-Gn(l),s=1<<i,a=r[i];a===-1?((s&n)===0||(s&o)!==0)&&(r[i]=a1(s,t)):a<=t&&(e.expiredLanes|=s),l&=~s}}function Vc(e){return e=e.pendingLanes&-1073741825,e!==0?e:e&1073741824?1073741824:0}function f0(){var e=is;return is<<=1,(is&4194240)===0&&(is=64),e}function hc(e){for(var t=[],n=0;31>n;n++)t.push(e);return t}function Ci(e,t,n){e.pendingLanes|=t,t!==536870912&&(e.suspendedLanes=0,e.pingedLanes=0),e=e.eventTimes,t=31-Gn(t),e[t]=n}function d1(e,t){var n=e.pendingLanes&~t;e.pendingLanes=t,e.suspendedLanes=0,e.pingedLanes=0,e.expiredLanes&=t,e.mutableReadLanes&=t,e.entangledLanes&=t,t=e.entanglements;var o=e.eventTimes;for(e=e.expirationTimes;0<n;){var r=31-Gn(n),l=1<<r;t[r]=0,o[r]=-1,e[r]=-1,n&=~l}}function Rd(e,t){var n=e.entangledLanes|=t;for(e=e.entanglements;n;){var o=31-Gn(n),r=1<<o;r&t|e[o]&t&&(e[o]|=t),n&=~r}}var rt=0;function h0(e){return e&=-e,1<e?4<e?(e&268435455)!==0?16:536870912:4:1}var p0,Td,m0,g0,y0,Kc=!1,as=[],Uo=null,Yo=null,Xo=null,di=new Map,ui=new Map,Wo=[],u1="mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset submit".split(" ");function Q_(e,t){switch(e){case"focusin":case"focusout":Uo=null;break;case"dragenter":case"dragleave":Yo=null;break;case"mouseover":case"mouseout":Xo=null;break;case"pointerover":case"pointerout":di.delete(t.pointerId);break;case"gotpointercapture":case"lostpointercapture":ui.delete(t.pointerId)}}function Fl(e,t,n,o,r,l){return e===null||e.nativeEvent!==l?(e={blockedOn:t,domEventName:n,eventSystemFlags:o,nativeEvent:l,targetContainers:[r]},t!==null&&(t=Mi(t),t!==null&&Td(t)),e):(e.eventSystemFlags|=o,t=e.targetContainers,r!==null&&t.indexOf(r)===-1&&t.push(r),e)}function _1(e,t,n,o,r){switch(t){case"focusin":return Uo=Fl(Uo,e,t,n,o,r),!0;case"dragenter":return Yo=Fl(Yo,e,t,n,o,r),!0;case"mouseover":return Xo=Fl(Xo,e,t,n,o,r),!0;case"pointerover":var l=r.pointerId;return di.set(l,Fl(di.get(l)||null,e,t,n,o,r)),!0;case"gotpointercapture":return l=r.pointerId,ui.set(l,Fl(ui.get(l)||null,e,t,n,o,r)),!0}return!1}function x0(e){var t=pr(e.target);if(t!==null){var n=Mr(t);if(n!==null){if(t=n.tag,t===13){if(t=s0(n),t!==null){e.blockedOn=t,y0(e.priority,function(){m0(n)});return}}else if(t===3&&n.stateNode.current.memoizedState.isDehydrated){e.blockedOn=n.tag===3?n.stateNode.containerInfo:null;return}}}e.blockedOn=null}function bs(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var n=Gc(e.domEventName,e.eventSystemFlags,t[0],e.nativeEvent);if(n===null){n=e.nativeEvent;var o=new n.constructor(n.type,n);Uc=o,n.target.dispatchEvent(o),Uc=null}else return t=Mi(n),t!==null&&Td(t),e.blockedOn=n,!1;t.shift()}return!0}function V_(e,t,n){bs(e)&&n.delete(t)}function f1(){Kc=!1,Uo!==null&&bs(Uo)&&(Uo=null),Yo!==null&&bs(Yo)&&(Yo=null),Xo!==null&&bs(Xo)&&(Xo=null),di.forEach(V_),ui.forEach(V_)}function jl(e,t){e.blockedOn===t&&(e.blockedOn=null,Kc||(Kc=!0,wn.unstable_scheduleCallback(wn.unstable_NormalPriority,f1)))}function _i(e){function t(r){return jl(r,e)}if(0<as.length){jl(as[0],e);for(var n=1;n<as.length;n++){var o=as[n];o.blockedOn===e&&(o.blockedOn=null)}}for(Uo!==null&&jl(Uo,e),Yo!==null&&jl(Yo,e),Xo!==null&&jl(Xo,e),di.forEach(t),ui.forEach(t),n=0;n<Wo.length;n++)o=Wo[n],o.blockedOn===e&&(o.blockedOn=null);for(;0<Wo.length&&(n=Wo[0],n.blockedOn===null);)x0(n),n.blockedOn===null&&Wo.shift()}var ll=No.ReactCurrentBatchConfig,zs=!0;function h1(e,t,n,o){var r=rt,l=ll.transition;ll.transition=null;try{rt=1,Pd(e,t,n,o)}finally{rt=r,ll.transition=l}}function p1(e,t,n,o){var r=rt,l=ll.transition;ll.transition=null;try{rt=4,Pd(e,t,n,o)}finally{rt=r,ll.transition=l}}function Pd(e,t,n,o){if(zs){var r=Gc(e,t,n,o);if(r===null)wc(e,t,o,Os,n),Q_(e,o);else if(_1(r,e,t,n,o))o.stopPropagation();else if(Q_(e,o),t&4&&-1<u1.indexOf(e)){for(;r!==null;){var l=Mi(r);if(l!==null&&p0(l),l=Gc(e,t,n,o),l===null&&wc(e,t,o,Os,n),l===r)break;r=l}r!==null&&o.stopPropagation()}else wc(e,t,o,null,n)}}var Os=null;function Gc(e,t,n,o){if(Os=null,e=Nd(o),e=pr(e),e!==null)if(t=Mr(e),t===null)e=null;else if(n=t.tag,n===13){if(e=s0(t),e!==null)return e;e=null}else if(n===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null);return Os=e,null}function v0(e){switch(e){case"cancel":case"click":case"close":case"contextmenu":case"copy":case"cut":case"auxclick":case"dblclick":case"dragend":case"dragstart":case"drop":case"focusin":case"focusout":case"input":case"invalid":case"keydown":case"keypress":case"keyup":case"mousedown":case"mouseup":case"paste":case"pause":case"play":case"pointercancel":case"pointerdown":case"pointerup":case"ratechange":case"reset":case"resize":case"seeked":case"submit":case"touchcancel":case"touchend":case"touchstart":case"volumechange":case"change":case"selectionchange":case"textInput":case"compositionstart":case"compositionend":case"compositionupdate":case"beforeblur":case"afterblur":case"beforeinput":case"blur":case"fullscreenchange":case"focus":case"hashchange":case"popstate":case"select":case"selectstart":return 1;case"drag":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"mousemove":case"mouseout":case"mouseover":case"pointermove":case"pointerout":case"pointerover":case"scroll":case"toggle":case"touchmove":case"wheel":case"mouseenter":case"mouseleave":case"pointerenter":case"pointerleave":return 4;case"message":switch(n1()){case $d:return 1;case u0:return 4;case Ds:case o1:return 16;case _0:return 536870912;default:return 16}default:return 16}}var jo=null,Dd=null,ks=null;function w0(){if(ks)return ks;var e,t=Dd,n=t.length,o,r="value"in jo?jo.value:jo.textContent,l=r.length;for(e=0;e<n&&t[e]===r[e];e++);var i=n-e;for(o=1;o<=i&&t[n-o]===r[l-o];o++);return ks=r.slice(e,1<o?1-o:void 0)}function Cs(e){var t=e.keyCode;return"charCode"in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function cs(){return!0}function K_(){return!1}function bn(e){function t(n,o,r,l,i){this._reactName=n,this._targetInst=r,this.type=o,this.nativeEvent=l,this.target=i,this.currentTarget=null;for(var s in e)e.hasOwnProperty(s)&&(n=e[s],this[s]=n?n(l):l[s]);return this.isDefaultPrevented=(l.defaultPrevented!=null?l.defaultPrevented:l.returnValue===!1)?cs:K_,this.isPropagationStopped=K_,this}return kt(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var n=this.nativeEvent;n&&(n.preventDefault?n.preventDefault():typeof n.returnValue!="unknown"&&(n.returnValue=!1),this.isDefaultPrevented=cs)},stopPropagation:function(){var n=this.nativeEvent;n&&(n.stopPropagation?n.stopPropagation():typeof n.cancelBubble!="unknown"&&(n.cancelBubble=!0),this.isPropagationStopped=cs)},persist:function(){},isPersistent:cs}),t}var pl={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Bd=bn(pl),Si=kt({},pl,{view:0,detail:0}),m1=bn(Si),pc,mc,Hl,oa=kt({},Si,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:zd,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){return"movementX"in e?e.movementX:(e!==Hl&&(Hl&&e.type==="mousemove"?(pc=e.screenX-Hl.screenX,mc=e.screenY-Hl.screenY):mc=pc=0,Hl=e),pc)},movementY:function(e){return"movementY"in e?e.movementY:mc}}),G_=bn(oa),g1=kt({},oa,{dataTransfer:0}),y1=bn(g1),x1=kt({},Si,{relatedTarget:0}),gc=bn(x1),v1=kt({},pl,{animationName:0,elapsedTime:0,pseudoElement:0}),w1=bn(v1),b1=kt({},pl,{clipboardData:function(e){return"clipboardData"in e?e.clipboardData:window.clipboardData}}),k1=bn(b1),C1=kt({},pl,{data:0}),q_=bn(C1),S1={Esc:"Escape",Spacebar:" ",Left:"ArrowLeft",Up:"ArrowUp",Right:"ArrowRight",Down:"ArrowDown",Del:"Delete",Win:"OS",Menu:"ContextMenu",Apps:"ContextMenu",Scroll:"ScrollLock",MozPrintableKey:"Unidentified"},M1={8:"Backspace",9:"Tab",12:"Clear",13:"Enter",16:"Shift",17:"Control",18:"Alt",19:"Pause",20:"CapsLock",27:"Escape",32:" ",33:"PageUp",34:"PageDown",35:"End",36:"Home",37:"ArrowLeft",38:"ArrowUp",39:"ArrowRight",40:"ArrowDown",45:"Insert",46:"Delete",112:"F1",113:"F2",114:"F3",115:"F4",116:"F5",117:"F6",118:"F7",119:"F8",120:"F9",121:"F10",122:"F11",123:"F12",144:"NumLock",145:"ScrollLock",224:"Meta"},E1={Alt:"altKey",Control:"ctrlKey",Meta:"metaKey",Shift:"shiftKey"};function L1(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=E1[e])?!!t[e]:!1}function zd(){return L1}var I1=kt({},Si,{key:function(e){if(e.key){var t=S1[e.key]||e.key;if(t!=="Unidentified")return t}return e.type==="keypress"?(e=Cs(e),e===13?"Enter":String.fromCharCode(e)):e.type==="keydown"||e.type==="keyup"?M1[e.keyCode]||"Unidentified":""},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:zd,charCode:function(e){return e.type==="keypress"?Cs(e):0},keyCode:function(e){return e.type==="keydown"||e.type==="keyup"?e.keyCode:0},which:function(e){return e.type==="keypress"?Cs(e):e.type==="keydown"||e.type==="keyup"?e.keyCode:0}}),N1=bn(I1),$1=kt({},oa,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0}),Z_=bn($1),R1=kt({},Si,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:zd}),T1=bn(R1),P1=kt({},pl,{propertyName:0,elapsedTime:0,pseudoElement:0}),D1=bn(P1),B1=kt({},oa,{deltaX:function(e){return"deltaX"in e?e.deltaX:"wheelDeltaX"in e?-e.wheelDeltaX:0},deltaY:function(e){return"deltaY"in e?e.deltaY:"wheelDeltaY"in e?-e.wheelDeltaY:"wheelDelta"in e?-e.wheelDelta:0},deltaZ:0,deltaMode:0}),z1=bn(B1),O1=[9,13,27,32],Od=Mo&&"CompositionEvent"in window,ei=null;Mo&&"documentMode"in document&&(ei=document.documentMode);var A1=Mo&&"TextEvent"in window&&!ei,b0=Mo&&(!Od||ei&&8<ei&&11>=ei),J_=" ",ef=!1;function k0(e,t){switch(e){case"keyup":return O1.indexOf(t.keyCode)!==-1;case"keydown":return t.keyCode!==229;case"keypress":case"mousedown":case"focusout":return!0;default:return!1}}function C0(e){return e=e.detail,typeof e=="object"&&"data"in e?e.data:null}var Xr=!1;function W1(e,t){switch(e){case"compositionend":return C0(t);case"keypress":return t.which!==32?null:(ef=!0,J_);case"textInput":return e=t.data,e===J_&&ef?null:e;default:return null}}function F1(e,t){if(Xr)return e==="compositionend"||!Od&&k0(e,t)?(e=w0(),ks=Dd=jo=null,Xr=!1,e):null;switch(e){case"paste":return null;case"keypress":if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case"compositionend":return b0&&t.locale!=="ko"?null:t.data;default:return null}}var j1={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function tf(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t==="input"?!!j1[e.type]:t==="textarea"}function S0(e,t,n,o){n0(o),t=As(t,"onChange"),0<t.length&&(n=new Bd("onChange","change",null,n,o),e.push({event:n,listeners:t}))}var ti=null,fi=null;function H1(e){B0(e,0)}function ra(e){var t=Kr(e);if(Kf(t))return e}function U1(e,t){if(e==="change")return t}var M0=!1;Mo&&(Mo?(us="oninput"in document,us||(yc=document.createElement("div"),yc.setAttribute("oninput","return;"),us=typeof yc.oninput=="function"),ds=us):ds=!1,M0=ds&&(!document.documentMode||9<document.documentMode));var ds,us,yc;function nf(){ti&&(ti.detachEvent("onpropertychange",E0),fi=ti=null)}function E0(e){if(e.propertyName==="value"&&ra(fi)){var t=[];S0(t,fi,e,Nd(e)),i0(H1,t)}}function Y1(e,t,n){e==="focusin"?(nf(),ti=t,fi=n,ti.attachEvent("onpropertychange",E0)):e==="focusout"&&nf()}function X1(e){if(e==="selectionchange"||e==="keyup"||e==="keydown")return ra(fi)}function Q1(e,t){if(e==="click")return ra(t)}function V1(e,t){if(e==="input"||e==="change")return ra(t)}function K1(e,t){return e===t&&(e!==0||1/e===1/t)||e!==e&&t!==t}var Zn=typeof Object.is=="function"?Object.is:K1;function hi(e,t){if(Zn(e,t))return!0;if(typeof e!="object"||e===null||typeof t!="object"||t===null)return!1;var n=Object.keys(e),o=Object.keys(t);if(n.length!==o.length)return!1;for(o=0;o<n.length;o++){var r=n[o];if(!Rc.call(t,r)||!Zn(e[r],t[r]))return!1}return!0}function of(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function rf(e,t){var n=of(e);e=0;for(var o;n;){if(n.nodeType===3){if(o=e+n.textContent.length,e<=t&&o>=t)return{node:n,offset:t-e};e=o}e:{for(;n;){if(n.nextSibling){n=n.nextSibling;break e}n=n.parentNode}n=void 0}n=of(n)}}function L0(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?L0(e,t.parentNode):"contains"in e?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function I0(){for(var e=window,t=Rs();t instanceof e.HTMLIFrameElement;){try{var n=typeof t.contentWindow.location.href=="string"}catch{n=!1}if(n)e=t.contentWindow;else break;t=Rs(e.document)}return t}function Ad(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t==="input"&&(e.type==="text"||e.type==="search"||e.type==="tel"||e.type==="url"||e.type==="password")||t==="textarea"||e.contentEditable==="true")}function G1(e){var t=I0(),n=e.focusedElem,o=e.selectionRange;if(t!==n&&n&&n.ownerDocument&&L0(n.ownerDocument.documentElement,n)){if(o!==null&&Ad(n)){if(t=o.start,e=o.end,e===void 0&&(e=t),"selectionStart"in n)n.selectionStart=t,n.selectionEnd=Math.min(e,n.value.length);else if(e=(t=n.ownerDocument||document)&&t.defaultView||window,e.getSelection){e=e.getSelection();var r=n.textContent.length,l=Math.min(o.start,r);o=o.end===void 0?l:Math.min(o.end,r),!e.extend&&l>o&&(r=o,o=l,l=r),r=rf(n,l);var i=rf(n,o);r&&i&&(e.rangeCount!==1||e.anchorNode!==r.node||e.anchorOffset!==r.offset||e.focusNode!==i.node||e.focusOffset!==i.offset)&&(t=t.createRange(),t.setStart(r.node,r.offset),e.removeAllRanges(),l>o?(e.addRange(t),e.extend(i.node,i.offset)):(t.setEnd(i.node,i.offset),e.addRange(t)))}}for(t=[],e=n;e=e.parentNode;)e.nodeType===1&&t.push({element:e,left:e.scrollLeft,top:e.scrollTop});for(typeof n.focus=="function"&&n.focus(),n=0;n<t.length;n++)e=t[n],e.element.scrollLeft=e.left,e.element.scrollTop=e.top}}var q1=Mo&&"documentMode"in document&&11>=document.documentMode,Qr=null,qc=null,ni=null,Zc=!1;function lf(e,t,n){var o=n.window===n?n.document:n.nodeType===9?n:n.ownerDocument;Zc||Qr==null||Qr!==Rs(o)||(o=Qr,"selectionStart"in o&&Ad(o)?o={start:o.selectionStart,end:o.selectionEnd}:(o=(o.ownerDocument&&o.ownerDocument.defaultView||window).getSelection(),o={anchorNode:o.anchorNode,anchorOffset:o.anchorOffset,focusNode:o.focusNode,focusOffset:o.focusOffset}),ni&&hi(ni,o)||(ni=o,o=As(qc,"onSelect"),0<o.length&&(t=new Bd("onSelect","select",null,t,n),e.push({event:t,listeners:o}),t.target=Qr)))}function _s(e,t){var n={};return n[e.toLowerCase()]=t.toLowerCase(),n["Webkit"+e]="webkit"+t,n["Moz"+e]="moz"+t,n}var Vr={animationend:_s("Animation","AnimationEnd"),animationiteration:_s("Animation","AnimationIteration"),animationstart:_s("Animation","AnimationStart"),transitionend:_s("Transition","TransitionEnd")},xc={},N0={};Mo&&(N0=document.createElement("div").style,"AnimationEvent"in window||(delete Vr.animationend.animation,delete Vr.animationiteration.animation,delete Vr.animationstart.animation),"TransitionEvent"in window||delete Vr.transitionend.transition);function la(e){if(xc[e])return xc[e];if(!Vr[e])return e;var t=Vr[e],n;for(n in t)if(t.hasOwnProperty(n)&&n in N0)return xc[e]=t[n];return e}var $0=la("animationend"),R0=la("animationiteration"),T0=la("animationstart"),P0=la("transitionend"),D0=new Map,sf="abort auxClick cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel".split(" ");function er(e,t){D0.set(e,t),Sr(t,[e])}for(fs=0;fs<sf.length;fs++)hs=sf[fs],af=hs.toLowerCase(),cf=hs[0].toUpperCase()+hs.slice(1),er(af,"on"+cf);var hs,af,cf,fs;er($0,"onAnimationEnd");er(R0,"onAnimationIteration");er(T0,"onAnimationStart");er("dblclick","onDoubleClick");er("focusin","onFocus");er("focusout","onBlur");er(P0,"onTransitionEnd");al("onMouseEnter",["mouseout","mouseover"]);al("onMouseLeave",["mouseout","mouseover"]);al("onPointerEnter",["pointerout","pointerover"]);al("onPointerLeave",["pointerout","pointerover"]);Sr("onChange","change click focusin focusout input keydown keyup selectionchange".split(" "));Sr("onSelect","focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange".split(" "));Sr("onBeforeInput",["compositionend","keypress","textInput","paste"]);Sr("onCompositionEnd","compositionend focusout keydown keypress keyup mousedown".split(" "));Sr("onCompositionStart","compositionstart focusout keydown keypress keyup mousedown".split(" "));Sr("onCompositionUpdate","compositionupdate focusout keydown keypress keyup mousedown".split(" "));var ql="abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting".split(" "),Z1=new Set("cancel close invalid load scroll toggle".split(" ").concat(ql));function df(e,t,n){var o=e.type||"unknown-event";e.currentTarget=n,Zm(o,t,void 0,e),e.currentTarget=null}function B0(e,t){t=(t&4)!==0;for(var n=0;n<e.length;n++){var o=e[n],r=o.event;o=o.listeners;e:{var l=void 0;if(t)for(var i=o.length-1;0<=i;i--){var s=o[i],a=s.instance,m=s.currentTarget;if(s=s.listener,a!==l&&r.isPropagationStopped())break e;df(r,s,m),l=a}else for(i=0;i<o.length;i++){if(s=o[i],a=s.instance,m=s.currentTarget,s=s.listener,a!==l&&r.isPropagationStopped())break e;df(r,s,m),l=a}}}if(Ps)throw e=Qc,Ps=!1,Qc=null,e}function pt(e,t){var n=t[od];n===void 0&&(n=t[od]=new Set);var o=e+"__bubble";n.has(o)||(z0(t,e,2,!1),n.add(o))}function vc(e,t,n){var o=0;t&&(o|=4),z0(n,e,o,t)}var ps="_reactListening"+Math.random().toString(36).slice(2);function pi(e){if(!e[ps]){e[ps]=!0,Uf.forEach(function(n){n!=="selectionchange"&&(Z1.has(n)||vc(n,!1,e),vc(n,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[ps]||(t[ps]=!0,vc("selectionchange",!1,t))}}function z0(e,t,n,o){switch(v0(t)){case 1:var r=h1;break;case 4:r=p1;break;default:r=Pd}n=r.bind(null,t,n,e),r=void 0,!Xc||t!=="touchstart"&&t!=="touchmove"&&t!=="wheel"||(r=!0),o?r!==void 0?e.addEventListener(t,n,{capture:!0,passive:r}):e.addEventListener(t,n,!0):r!==void 0?e.addEventListener(t,n,{passive:r}):e.addEventListener(t,n,!1)}function wc(e,t,n,o,r){var l=o;if((t&1)===0&&(t&2)===0&&o!==null)e:for(;;){if(o===null)return;var i=o.tag;if(i===3||i===4){var s=o.stateNode.containerInfo;if(s===r||s.nodeType===8&&s.parentNode===r)break;if(i===4)for(i=o.return;i!==null;){var a=i.tag;if((a===3||a===4)&&(a=i.stateNode.containerInfo,a===r||a.nodeType===8&&a.parentNode===r))return;i=i.return}for(;s!==null;){if(i=pr(s),i===null)return;if(a=i.tag,a===5||a===6){o=l=i;continue e}s=s.parentNode}}o=o.return}i0(function(){var m=l,p=Nd(n),b=[];e:{var y=D0.get(e);if(y!==void 0){var $=Bd,C=e;switch(e){case"keypress":if(Cs(n)===0)break e;case"keydown":case"keyup":$=N1;break;case"focusin":C="focus",$=gc;break;case"focusout":C="blur",$=gc;break;case"beforeblur":case"afterblur":$=gc;break;case"click":if(n.button===2)break e;case"auxclick":case"dblclick":case"mousedown":case"mousemove":case"mouseup":case"mouseout":case"mouseover":case"contextmenu":$=G_;break;case"drag":case"dragend":case"dragenter":case"dragexit":case"dragleave":case"dragover":case"dragstart":case"drop":$=y1;break;case"touchcancel":case"touchend":case"touchmove":case"touchstart":$=T1;break;case $0:case R0:case T0:$=w1;break;case P0:$=D1;break;case"scroll":$=m1;break;case"wheel":$=z1;break;case"copy":case"cut":case"paste":$=k1;break;case"gotpointercapture":case"lostpointercapture":case"pointercancel":case"pointerdown":case"pointermove":case"pointerout":case"pointerover":case"pointerup":$=Z_}var I=(t&4)!==0,E=!I&&e==="scroll",f=I?y!==null?y+"Capture":null:y;I=[];for(var g=m,w;g!==null;){w=g;var N=w.stateNode;if(w.tag===5&&N!==null&&(w=N,f!==null&&(N=ci(g,f),N!=null&&I.push(mi(g,N,w)))),E)break;g=g.return}0<I.length&&(y=new $(y,C,null,n,p),b.push({event:y,listeners:I}))}}if((t&7)===0){e:{if(y=e==="mouseover"||e==="pointerover",$=e==="mouseout"||e==="pointerout",y&&n!==Uc&&(C=n.relatedTarget||n.fromElement)&&(pr(C)||C[Eo]))break e;if(($||y)&&(y=p.window===p?p:(y=p.ownerDocument)?y.defaultView||y.parentWindow:window,$?(C=n.relatedTarget||n.toElement,$=m,C=C?pr(C):null,C!==null&&(E=Mr(C),C!==E||C.tag!==5&&C.tag!==6)&&(C=null)):($=null,C=m),$!==C)){if(I=G_,N="onMouseLeave",f="onMouseEnter",g="mouse",(e==="pointerout"||e==="pointerover")&&(I=Z_,N="onPointerLeave",f="onPointerEnter",g="pointer"),E=$==null?y:Kr($),w=C==null?y:Kr(C),y=new I(N,g+"leave",$,n,p),y.target=E,y.relatedTarget=w,N=null,pr(p)===m&&(I=new I(f,g+"enter",C,n,p),I.target=w,I.relatedTarget=E,N=I),E=N,$&&C)t:{for(I=$,f=C,g=0,w=I;w;w=Hr(w))g++;for(w=0,N=f;N;N=Hr(N))w++;for(;0<g-w;)I=Hr(I),g--;for(;0<w-g;)f=Hr(f),w--;for(;g--;){if(I===f||f!==null&&I===f.alternate)break t;I=Hr(I),f=Hr(f)}I=null}else I=null;$!==null&&uf(b,y,$,I,!1),C!==null&&E!==null&&uf(b,E,C,I,!0)}}e:{if(y=m?Kr(m):window,$=y.nodeName&&y.nodeName.toLowerCase(),$==="select"||$==="input"&&y.type==="file")var H=U1;else if(tf(y))if(M0)H=V1;else{H=X1;var V=Y1}else($=y.nodeName)&&$.toLowerCase()==="input"&&(y.type==="checkbox"||y.type==="radio")&&(H=Q1);if(H&&(H=H(e,m))){S0(b,H,n,p);break e}V&&V(e,y,m),e==="focusout"&&(V=y._wrapperState)&&V.controlled&&y.type==="number"&&Ac(y,"number",y.value)}switch(V=m?Kr(m):window,e){case"focusin":(tf(V)||V.contentEditable==="true")&&(Qr=V,qc=m,ni=null);break;case"focusout":ni=qc=Qr=null;break;case"mousedown":Zc=!0;break;case"contextmenu":case"mouseup":case"dragend":Zc=!1,lf(b,n,p);break;case"selectionchange":if(q1)break;case"keydown":case"keyup":lf(b,n,p)}var D;if(Od)e:{switch(e){case"compositionstart":var G="onCompositionStart";break e;case"compositionend":G="onCompositionEnd";break e;case"compositionupdate":G="onCompositionUpdate";break e}G=void 0}else Xr?k0(e,n)&&(G="onCompositionEnd"):e==="keydown"&&n.keyCode===229&&(G="onCompositionStart");G&&(b0&&n.locale!=="ko"&&(Xr||G!=="onCompositionStart"?G==="onCompositionEnd"&&Xr&&(D=w0()):(jo=p,Dd="value"in jo?jo.value:jo.textContent,Xr=!0)),V=As(m,G),0<V.length&&(G=new q_(G,e,null,n,p),b.push({event:G,listeners:V}),D?G.data=D:(D=C0(n),D!==null&&(G.data=D)))),(D=A1?W1(e,n):F1(e,n))&&(m=As(m,"onBeforeInput"),0<m.length&&(p=new q_("onBeforeInput","beforeinput",null,n,p),b.push({event:p,listeners:m}),p.data=D))}B0(b,t)})}function mi(e,t,n){return{instance:e,listener:t,currentTarget:n}}function As(e,t){for(var n=t+"Capture",o=[];e!==null;){var r=e,l=r.stateNode;r.tag===5&&l!==null&&(r=l,l=ci(e,n),l!=null&&o.unshift(mi(e,l,r)),l=ci(e,t),l!=null&&o.push(mi(e,l,r))),e=e.return}return o}function Hr(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5);return e||null}function uf(e,t,n,o,r){for(var l=t._reactName,i=[];n!==null&&n!==o;){var s=n,a=s.alternate,m=s.stateNode;if(a!==null&&a===o)break;s.tag===5&&m!==null&&(s=m,r?(a=ci(n,l),a!=null&&i.unshift(mi(n,a,s))):r||(a=ci(n,l),a!=null&&i.push(mi(n,a,s)))),n=n.return}i.length!==0&&e.push({event:t,listeners:i})}var J1=/\r\n?/g,eg=/\u0000|\uFFFD/g;function _f(e){return(typeof e=="string"?e:""+e).replace(J1,`
`).replace(eg,"")}function ms(e,t,n){if(t=_f(t),_f(e)!==t&&n)throw Error(j(425))}function Ws(){}var Jc=null,ed=null;function td(e,t){return e==="textarea"||e==="noscript"||typeof t.children=="string"||typeof t.children=="number"||typeof t.dangerouslySetInnerHTML=="object"&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}var nd=typeof setTimeout=="function"?setTimeout:void 0,tg=typeof clearTimeout=="function"?clearTimeout:void 0,ff=typeof Promise=="function"?Promise:void 0,ng=typeof queueMicrotask=="function"?queueMicrotask:typeof ff<"u"?function(e){return ff.resolve(null).then(e).catch(og)}:nd;function og(e){setTimeout(function(){throw e})}function bc(e,t){var n=t,o=0;do{var r=n.nextSibling;if(e.removeChild(n),r&&r.nodeType===8)if(n=r.data,n==="/$"){if(o===0){e.removeChild(r),_i(t);return}o--}else n!=="$"&&n!=="$?"&&n!=="$!"||o++;n=r}while(n);_i(t)}function Qo(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t==="$"||t==="$!"||t==="$?")break;if(t==="/$")return null}}return e}function hf(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="$"||n==="$!"||n==="$?"){if(t===0)return e;t--}else n==="/$"&&t++}e=e.previousSibling}return null}var ml=Math.random().toString(36).slice(2),uo="__reactFiber$"+ml,gi="__reactProps$"+ml,Eo="__reactContainer$"+ml,od="__reactEvents$"+ml,rg="__reactListeners$"+ml,lg="__reactHandles$"+ml;function pr(e){var t=e[uo];if(t)return t;for(var n=e.parentNode;n;){if(t=n[Eo]||n[uo]){if(n=t.alternate,t.child!==null||n!==null&&n.child!==null)for(e=hf(e);e!==null;){if(n=e[uo])return n;e=hf(e)}return t}e=n,n=e.parentNode}return null}function Mi(e){return e=e[uo]||e[Eo],!e||e.tag!==5&&e.tag!==6&&e.tag!==13&&e.tag!==3?null:e}function Kr(e){if(e.tag===5||e.tag===6)return e.stateNode;throw Error(j(33))}function ia(e){return e[gi]||null}var rd=[],Gr=-1;function tr(e){return{current:e}}function mt(e){0>Gr||(e.current=rd[Gr],rd[Gr]=null,Gr--)}function ht(e,t){Gr++,rd[Gr]=e.current,e.current=t}var Jo={},Jt=tr(Jo),hn=tr(!1),vr=Jo;function cl(e,t){var n=e.type.contextTypes;if(!n)return Jo;var o=e.stateNode;if(o&&o.__reactInternalMemoizedUnmaskedChildContext===t)return o.__reactInternalMemoizedMaskedChildContext;var r={},l;for(l in n)r[l]=t[l];return o&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=t,e.__reactInternalMemoizedMaskedChildContext=r),r}function pn(e){return e=e.childContextTypes,e!=null}function Fs(){mt(hn),mt(Jt)}function pf(e,t,n){if(Jt.current!==Jo)throw Error(j(168));ht(Jt,t),ht(hn,n)}function O0(e,t,n){var o=e.stateNode;if(t=t.childContextTypes,typeof o.getChildContext!="function")return n;o=o.getChildContext();for(var r in o)if(!(r in t))throw Error(j(108,Ym(e)||"Unknown",r));return kt({},n,o)}function js(e){return e=(e=e.stateNode)&&e.__reactInternalMemoizedMergedChildContext||Jo,vr=Jt.current,ht(Jt,e),ht(hn,hn.current),!0}function mf(e,t,n){var o=e.stateNode;if(!o)throw Error(j(169));n?(e=O0(e,t,vr),o.__reactInternalMemoizedMergedChildContext=e,mt(hn),mt(Jt),ht(Jt,e)):mt(hn),ht(hn,n)}var bo=null,sa=!1,kc=!1;function A0(e){bo===null?bo=[e]:bo.push(e)}function ig(e){sa=!0,A0(e)}function nr(){if(!kc&&bo!==null){kc=!0;var e=0,t=rt;try{var n=bo;for(rt=1;e<n.length;e++){var o=n[e];do o=o(!0);while(o!==null)}bo=null,sa=!1}catch(r){throw bo!==null&&(bo=bo.slice(e+1)),d0($d,nr),r}finally{rt=t,kc=!1}}return null}var qr=[],Zr=0,Hs=null,Us=0,Rn=[],Tn=0,wr=null,ko=1,Co="";function fr(e,t){qr[Zr++]=Us,qr[Zr++]=Hs,Hs=e,Us=t}function W0(e,t,n){Rn[Tn++]=ko,Rn[Tn++]=Co,Rn[Tn++]=wr,wr=e;var o=ko;e=Co;var r=32-Gn(o)-1;o&=~(1<<r),n+=1;var l=32-Gn(t)+r;if(30<l){var i=r-r%5;l=(o&(1<<i)-1).toString(32),o>>=i,r-=i,ko=1<<32-Gn(t)+r|n<<r|o,Co=l+e}else ko=1<<l|n<<r|o,Co=e}function Wd(e){e.return!==null&&(fr(e,1),W0(e,1,0))}function Fd(e){for(;e===Hs;)Hs=qr[--Zr],qr[Zr]=null,Us=qr[--Zr],qr[Zr]=null;for(;e===wr;)wr=Rn[--Tn],Rn[Tn]=null,Co=Rn[--Tn],Rn[Tn]=null,ko=Rn[--Tn],Rn[Tn]=null}var vn=null,xn=null,gt=!1,Kn=null;function F0(e,t){var n=Pn(5,null,null,0);n.elementType="DELETED",n.stateNode=t,n.return=e,t=e.deletions,t===null?(e.deletions=[n],e.flags|=16):t.push(n)}function gf(e,t){switch(e.tag){case 5:var n=e.type;return t=t.nodeType!==1||n.toLowerCase()!==t.nodeName.toLowerCase()?null:t,t!==null?(e.stateNode=t,vn=e,xn=Qo(t.firstChild),!0):!1;case 6:return t=e.pendingProps===""||t.nodeType!==3?null:t,t!==null?(e.stateNode=t,vn=e,xn=null,!0):!1;case 13:return t=t.nodeType!==8?null:t,t!==null?(n=wr!==null?{id:ko,overflow:Co}:null,e.memoizedState={dehydrated:t,treeContext:n,retryLane:1073741824},n=Pn(18,null,null,0),n.stateNode=t,n.return=e,e.child=n,vn=e,xn=null,!0):!1;default:return!1}}function ld(e){return(e.mode&1)!==0&&(e.flags&128)===0}function id(e){if(gt){var t=xn;if(t){var n=t;if(!gf(e,t)){if(ld(e))throw Error(j(418));t=Qo(n.nextSibling);var o=vn;t&&gf(e,t)?F0(o,n):(e.flags=e.flags&-4097|2,gt=!1,vn=e)}}else{if(ld(e))throw Error(j(418));e.flags=e.flags&-4097|2,gt=!1,vn=e}}}function yf(e){for(e=e.return;e!==null&&e.tag!==5&&e.tag!==3&&e.tag!==13;)e=e.return;vn=e}function gs(e){if(e!==vn)return!1;if(!gt)return yf(e),gt=!0,!1;var t;if((t=e.tag!==3)&&!(t=e.tag!==5)&&(t=e.type,t=t!=="head"&&t!=="body"&&!td(e.type,e.memoizedProps)),t&&(t=xn)){if(ld(e))throw j0(),Error(j(418));for(;t;)F0(e,t),t=Qo(t.nextSibling)}if(yf(e),e.tag===13){if(e=e.memoizedState,e=e!==null?e.dehydrated:null,!e)throw Error(j(317));e:{for(e=e.nextSibling,t=0;e;){if(e.nodeType===8){var n=e.data;if(n==="/$"){if(t===0){xn=Qo(e.nextSibling);break e}t--}else n!=="$"&&n!=="$!"&&n!=="$?"||t++}e=e.nextSibling}xn=null}}else xn=vn?Qo(e.stateNode.nextSibling):null;return!0}function j0(){for(var e=xn;e;)e=Qo(e.nextSibling)}function dl(){xn=vn=null,gt=!1}function jd(e){Kn===null?Kn=[e]:Kn.push(e)}var sg=No.ReactCurrentBatchConfig;function Ul(e,t,n){if(e=n.ref,e!==null&&typeof e!="function"&&typeof e!="object"){if(n._owner){if(n=n._owner,n){if(n.tag!==1)throw Error(j(309));var o=n.stateNode}if(!o)throw Error(j(147,e));var r=o,l=""+e;return t!==null&&t.ref!==null&&typeof t.ref=="function"&&t.ref._stringRef===l?t.ref:(t=function(i){var s=r.refs;i===null?delete s[l]:s[l]=i},t._stringRef=l,t)}if(typeof e!="string")throw Error(j(284));if(!n._owner)throw Error(j(290,e))}return e}function ys(e,t){throw e=Object.prototype.toString.call(t),Error(j(31,e==="[object Object]"?"object with keys {"+Object.keys(t).join(", ")+"}":e))}function xf(e){var t=e._init;return t(e._payload)}function H0(e){function t(f,g){if(e){var w=f.deletions;w===null?(f.deletions=[g],f.flags|=16):w.push(g)}}function n(f,g){if(!e)return null;for(;g!==null;)t(f,g),g=g.sibling;return null}function o(f,g){for(f=new Map;g!==null;)g.key!==null?f.set(g.key,g):f.set(g.index,g),g=g.sibling;return f}function r(f,g){return f=qo(f,g),f.index=0,f.sibling=null,f}function l(f,g,w){return f.index=w,e?(w=f.alternate,w!==null?(w=w.index,w<g?(f.flags|=2,g):w):(f.flags|=2,g)):(f.flags|=1048576,g)}function i(f){return e&&f.alternate===null&&(f.flags|=2),f}function s(f,g,w,N){return g===null||g.tag!==6?(g=Nc(w,f.mode,N),g.return=f,g):(g=r(g,w),g.return=f,g)}function a(f,g,w,N){var H=w.type;return H===Yr?p(f,g,w.props.children,N,w.key):g!==null&&(g.elementType===H||typeof H=="object"&&H!==null&&H.$$typeof===Oo&&xf(H)===g.type)?(N=r(g,w.props),N.ref=Ul(f,g,w),N.return=f,N):(N=$s(w.type,w.key,w.props,null,f.mode,N),N.ref=Ul(f,g,w),N.return=f,N)}function m(f,g,w,N){return g===null||g.tag!==4||g.stateNode.containerInfo!==w.containerInfo||g.stateNode.implementation!==w.implementation?(g=$c(w,f.mode,N),g.return=f,g):(g=r(g,w.children||[]),g.return=f,g)}function p(f,g,w,N,H){return g===null||g.tag!==7?(g=xr(w,f.mode,N,H),g.return=f,g):(g=r(g,w),g.return=f,g)}function b(f,g,w){if(typeof g=="string"&&g!==""||typeof g=="number")return g=Nc(""+g,f.mode,w),g.return=f,g;if(typeof g=="object"&&g!==null){switch(g.$$typeof){case os:return w=$s(g.type,g.key,g.props,null,f.mode,w),w.ref=Ul(f,null,g),w.return=f,w;case Ur:return g=$c(g,f.mode,w),g.return=f,g;case Oo:var N=g._init;return b(f,N(g._payload),w)}if(Kl(g)||Wl(g))return g=xr(g,f.mode,w,null),g.return=f,g;ys(f,g)}return null}function y(f,g,w,N){var H=g!==null?g.key:null;if(typeof w=="string"&&w!==""||typeof w=="number")return H!==null?null:s(f,g,""+w,N);if(typeof w=="object"&&w!==null){switch(w.$$typeof){case os:return w.key===H?a(f,g,w,N):null;case Ur:return w.key===H?m(f,g,w,N):null;case Oo:return H=w._init,y(f,g,H(w._payload),N)}if(Kl(w)||Wl(w))return H!==null?null:p(f,g,w,N,null);ys(f,w)}return null}function $(f,g,w,N,H){if(typeof N=="string"&&N!==""||typeof N=="number")return f=f.get(w)||null,s(g,f,""+N,H);if(typeof N=="object"&&N!==null){switch(N.$$typeof){case os:return f=f.get(N.key===null?w:N.key)||null,a(g,f,N,H);case Ur:return f=f.get(N.key===null?w:N.key)||null,m(g,f,N,H);case Oo:var V=N._init;return $(f,g,w,V(N._payload),H)}if(Kl(N)||Wl(N))return f=f.get(w)||null,p(g,f,N,H,null);ys(g,N)}return null}function C(f,g,w,N){for(var H=null,V=null,D=g,G=g=0,ye=null;D!==null&&G<w.length;G++){D.index>G?(ye=D,D=null):ye=D.sibling;var Z=y(f,D,w[G],N);if(Z===null){D===null&&(D=ye);break}e&&D&&Z.alternate===null&&t(f,D),g=l(Z,g,G),V===null?H=Z:V.sibling=Z,V=Z,D=ye}if(G===w.length)return n(f,D),gt&&fr(f,G),H;if(D===null){for(;G<w.length;G++)D=b(f,w[G],N),D!==null&&(g=l(D,g,G),V===null?H=D:V.sibling=D,V=D);return gt&&fr(f,G),H}for(D=o(f,D);G<w.length;G++)ye=$(D,f,G,w[G],N),ye!==null&&(e&&ye.alternate!==null&&D.delete(ye.key===null?G:ye.key),g=l(ye,g,G),V===null?H=ye:V.sibling=ye,V=ye);return e&&D.forEach(function(he){return t(f,he)}),gt&&fr(f,G),H}function I(f,g,w,N){var H=Wl(w);if(typeof H!="function")throw Error(j(150));if(w=H.call(w),w==null)throw Error(j(151));for(var V=H=null,D=g,G=g=0,ye=null,Z=w.next();D!==null&&!Z.done;G++,Z=w.next()){D.index>G?(ye=D,D=null):ye=D.sibling;var he=y(f,D,Z.value,N);if(he===null){D===null&&(D=ye);break}e&&D&&he.alternate===null&&t(f,D),g=l(he,g,G),V===null?H=he:V.sibling=he,V=he,D=ye}if(Z.done)return n(f,D),gt&&fr(f,G),H;if(D===null){for(;!Z.done;G++,Z=w.next())Z=b(f,Z.value,N),Z!==null&&(g=l(Z,g,G),V===null?H=Z:V.sibling=Z,V=Z);return gt&&fr(f,G),H}for(D=o(f,D);!Z.done;G++,Z=w.next())Z=$(D,f,G,Z.value,N),Z!==null&&(e&&Z.alternate!==null&&D.delete(Z.key===null?G:Z.key),g=l(Z,g,G),V===null?H=Z:V.sibling=Z,V=Z);return e&&D.forEach(function(Ge){return t(f,Ge)}),gt&&fr(f,G),H}function E(f,g,w,N){if(typeof w=="object"&&w!==null&&w.type===Yr&&w.key===null&&(w=w.props.children),typeof w=="object"&&w!==null){switch(w.$$typeof){case os:e:{for(var H=w.key,V=g;V!==null;){if(V.key===H){if(H=w.type,H===Yr){if(V.tag===7){n(f,V.sibling),g=r(V,w.props.children),g.return=f,f=g;break e}}else if(V.elementType===H||typeof H=="object"&&H!==null&&H.$$typeof===Oo&&xf(H)===V.type){n(f,V.sibling),g=r(V,w.props),g.ref=Ul(f,V,w),g.return=f,f=g;break e}n(f,V);break}else t(f,V);V=V.sibling}w.type===Yr?(g=xr(w.props.children,f.mode,N,w.key),g.return=f,f=g):(N=$s(w.type,w.key,w.props,null,f.mode,N),N.ref=Ul(f,g,w),N.return=f,f=N)}return i(f);case Ur:e:{for(V=w.key;g!==null;){if(g.key===V)if(g.tag===4&&g.stateNode.containerInfo===w.containerInfo&&g.stateNode.implementation===w.implementation){n(f,g.sibling),g=r(g,w.children||[]),g.return=f,f=g;break e}else{n(f,g);break}else t(f,g);g=g.sibling}g=$c(w,f.mode,N),g.return=f,f=g}return i(f);case Oo:return V=w._init,E(f,g,V(w._payload),N)}if(Kl(w))return C(f,g,w,N);if(Wl(w))return I(f,g,w,N);ys(f,w)}return typeof w=="string"&&w!==""||typeof w=="number"?(w=""+w,g!==null&&g.tag===6?(n(f,g.sibling),g=r(g,w),g.return=f,f=g):(n(f,g),g=Nc(w,f.mode,N),g.return=f,f=g),i(f)):n(f,g)}return E}var ul=H0(!0),U0=H0(!1),Ys=tr(null),Xs=null,Jr=null,Hd=null;function Ud(){Hd=Jr=Xs=null}function Yd(e){var t=Ys.current;mt(Ys),e._currentValue=t}function sd(e,t,n){for(;e!==null;){var o=e.alternate;if((e.childLanes&t)!==t?(e.childLanes|=t,o!==null&&(o.childLanes|=t)):o!==null&&(o.childLanes&t)!==t&&(o.childLanes|=t),e===n)break;e=e.return}}function il(e,t){Xs=e,Hd=Jr=null,e=e.dependencies,e!==null&&e.firstContext!==null&&((e.lanes&t)!==0&&(fn=!0),e.firstContext=null)}function Bn(e){var t=e._currentValue;if(Hd!==e)if(e={context:e,memoizedValue:t,next:null},Jr===null){if(Xs===null)throw Error(j(308));Jr=e,Xs.dependencies={lanes:0,firstContext:e}}else Jr=Jr.next=e;return t}var mr=null;function Xd(e){mr===null?mr=[e]:mr.push(e)}function Y0(e,t,n,o){var r=t.interleaved;return r===null?(n.next=n,Xd(t)):(n.next=r.next,r.next=n),t.interleaved=n,Lo(e,o)}function Lo(e,t){e.lanes|=t;var n=e.alternate;for(n!==null&&(n.lanes|=t),n=e,e=e.return;e!==null;)e.childLanes|=t,n=e.alternate,n!==null&&(n.childLanes|=t),n=e,e=e.return;return n.tag===3?n.stateNode:null}var Ao=!1;function Qd(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,interleaved:null,lanes:0},effects:null}}function X0(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,effects:e.effects})}function So(e,t){return{eventTime:e,lane:t,tag:0,payload:null,callback:null,next:null}}function Vo(e,t,n){var o=e.updateQueue;if(o===null)return null;if(o=o.shared,(Qe&2)!==0){var r=o.pending;return r===null?t.next=t:(t.next=r.next,r.next=t),o.pending=t,Lo(e,n)}return r=o.interleaved,r===null?(t.next=t,Xd(o)):(t.next=r.next,r.next=t),o.interleaved=t,Lo(e,n)}function Ss(e,t,n){if(t=t.updateQueue,t!==null&&(t=t.shared,(n&4194240)!==0)){var o=t.lanes;o&=e.pendingLanes,n|=o,t.lanes=n,Rd(e,n)}}function vf(e,t){var n=e.updateQueue,o=e.alternate;if(o!==null&&(o=o.updateQueue,n===o)){var r=null,l=null;if(n=n.firstBaseUpdate,n!==null){do{var i={eventTime:n.eventTime,lane:n.lane,tag:n.tag,payload:n.payload,callback:n.callback,next:null};l===null?r=l=i:l=l.next=i,n=n.next}while(n!==null);l===null?r=l=t:l=l.next=t}else r=l=t;n={baseState:o.baseState,firstBaseUpdate:r,lastBaseUpdate:l,shared:o.shared,effects:o.effects},e.updateQueue=n;return}e=n.lastBaseUpdate,e===null?n.firstBaseUpdate=t:e.next=t,n.lastBaseUpdate=t}function Qs(e,t,n,o){var r=e.updateQueue;Ao=!1;var l=r.firstBaseUpdate,i=r.lastBaseUpdate,s=r.shared.pending;if(s!==null){r.shared.pending=null;var a=s,m=a.next;a.next=null,i===null?l=m:i.next=m,i=a;var p=e.alternate;p!==null&&(p=p.updateQueue,s=p.lastBaseUpdate,s!==i&&(s===null?p.firstBaseUpdate=m:s.next=m,p.lastBaseUpdate=a))}if(l!==null){var b=r.baseState;i=0,p=m=a=null,s=l;do{var y=s.lane,$=s.eventTime;if((o&y)===y){p!==null&&(p=p.next={eventTime:$,lane:0,tag:s.tag,payload:s.payload,callback:s.callback,next:null});e:{var C=e,I=s;switch(y=t,$=n,I.tag){case 1:if(C=I.payload,typeof C=="function"){b=C.call($,b,y);break e}b=C;break e;case 3:C.flags=C.flags&-65537|128;case 0:if(C=I.payload,y=typeof C=="function"?C.call($,b,y):C,y==null)break e;b=kt({},b,y);break e;case 2:Ao=!0}}s.callback!==null&&s.lane!==0&&(e.flags|=64,y=r.effects,y===null?r.effects=[s]:y.push(s))}else $={eventTime:$,lane:y,tag:s.tag,payload:s.payload,callback:s.callback,next:null},p===null?(m=p=$,a=b):p=p.next=$,i|=y;if(s=s.next,s===null){if(s=r.shared.pending,s===null)break;y=s,s=y.next,y.next=null,r.lastBaseUpdate=y,r.shared.pending=null}}while(!0);if(p===null&&(a=b),r.baseState=a,r.firstBaseUpdate=m,r.lastBaseUpdate=p,t=r.shared.interleaved,t!==null){r=t;do i|=r.lane,r=r.next;while(r!==t)}else l===null&&(r.shared.lanes=0);kr|=i,e.lanes=i,e.memoizedState=b}}function wf(e,t,n){if(e=t.effects,t.effects=null,e!==null)for(t=0;t<e.length;t++){var o=e[t],r=o.callback;if(r!==null){if(o.callback=null,o=n,typeof r!="function")throw Error(j(191,r));r.call(o)}}}var Ei={},fo=tr(Ei),yi=tr(Ei),xi=tr(Ei);function gr(e){if(e===Ei)throw Error(j(174));return e}function Vd(e,t){switch(ht(xi,t),ht(yi,e),ht(fo,Ei),e=t.nodeType,e){case 9:case 11:t=(t=t.documentElement)?t.namespaceURI:Fc(null,"");break;default:e=e===8?t.parentNode:t,t=e.namespaceURI||null,e=e.tagName,t=Fc(t,e)}mt(fo),ht(fo,t)}function _l(){mt(fo),mt(yi),mt(xi)}function Q0(e){gr(xi.current);var t=gr(fo.current),n=Fc(t,e.type);t!==n&&(ht(yi,e),ht(fo,n))}function Kd(e){yi.current===e&&(mt(fo),mt(yi))}var wt=tr(0);function Vs(e){for(var t=e;t!==null;){if(t.tag===13){var n=t.memoizedState;if(n!==null&&(n=n.dehydrated,n===null||n.data==="$?"||n.data==="$!"))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==void 0){if((t.flags&128)!==0)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}var Cc=[];function Gd(){for(var e=0;e<Cc.length;e++)Cc[e]._workInProgressVersionPrimary=null;Cc.length=0}var Ms=No.ReactCurrentDispatcher,Sc=No.ReactCurrentBatchConfig,br=0,bt=null,At=null,jt=null,Ks=!1,oi=!1,vi=0,ag=0;function Gt(){throw Error(j(321))}function qd(e,t){if(t===null)return!1;for(var n=0;n<t.length&&n<e.length;n++)if(!Zn(e[n],t[n]))return!1;return!0}function Zd(e,t,n,o,r,l){if(br=l,bt=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,Ms.current=e===null||e.memoizedState===null?_g:fg,e=n(o,r),oi){l=0;do{if(oi=!1,vi=0,25<=l)throw Error(j(301));l+=1,jt=At=null,t.updateQueue=null,Ms.current=hg,e=n(o,r)}while(oi)}if(Ms.current=Gs,t=At!==null&&At.next!==null,br=0,jt=At=bt=null,Ks=!1,t)throw Error(j(300));return e}function Jd(){var e=vi!==0;return vi=0,e}function co(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return jt===null?bt.memoizedState=jt=e:jt=jt.next=e,jt}function zn(){if(At===null){var e=bt.alternate;e=e!==null?e.memoizedState:null}else e=At.next;var t=jt===null?bt.memoizedState:jt.next;if(t!==null)jt=t,At=e;else{if(e===null)throw Error(j(310));At=e,e={memoizedState:At.memoizedState,baseState:At.baseState,baseQueue:At.baseQueue,queue:At.queue,next:null},jt===null?bt.memoizedState=jt=e:jt=jt.next=e}return jt}function wi(e,t){return typeof t=="function"?t(e):t}function Mc(e){var t=zn(),n=t.queue;if(n===null)throw Error(j(311));n.lastRenderedReducer=e;var o=At,r=o.baseQueue,l=n.pending;if(l!==null){if(r!==null){var i=r.next;r.next=l.next,l.next=i}o.baseQueue=r=l,n.pending=null}if(r!==null){l=r.next,o=o.baseState;var s=i=null,a=null,m=l;do{var p=m.lane;if((br&p)===p)a!==null&&(a=a.next={lane:0,action:m.action,hasEagerState:m.hasEagerState,eagerState:m.eagerState,next:null}),o=m.hasEagerState?m.eagerState:e(o,m.action);else{var b={lane:p,action:m.action,hasEagerState:m.hasEagerState,eagerState:m.eagerState,next:null};a===null?(s=a=b,i=o):a=a.next=b,bt.lanes|=p,kr|=p}m=m.next}while(m!==null&&m!==l);a===null?i=o:a.next=s,Zn(o,t.memoizedState)||(fn=!0),t.memoizedState=o,t.baseState=i,t.baseQueue=a,n.lastRenderedState=o}if(e=n.interleaved,e!==null){r=e;do l=r.lane,bt.lanes|=l,kr|=l,r=r.next;while(r!==e)}else r===null&&(n.lanes=0);return[t.memoizedState,n.dispatch]}function Ec(e){var t=zn(),n=t.queue;if(n===null)throw Error(j(311));n.lastRenderedReducer=e;var o=n.dispatch,r=n.pending,l=t.memoizedState;if(r!==null){n.pending=null;var i=r=r.next;do l=e(l,i.action),i=i.next;while(i!==r);Zn(l,t.memoizedState)||(fn=!0),t.memoizedState=l,t.baseQueue===null&&(t.baseState=l),n.lastRenderedState=l}return[l,o]}function V0(){}function K0(e,t){var n=bt,o=zn(),r=t(),l=!Zn(o.memoizedState,r);if(l&&(o.memoizedState=r,fn=!0),o=o.queue,eu(Z0.bind(null,n,o,e),[e]),o.getSnapshot!==t||l||jt!==null&&jt.memoizedState.tag&1){if(n.flags|=2048,bi(9,q0.bind(null,n,o,r,t),void 0,null),Ht===null)throw Error(j(349));(br&30)!==0||G0(n,t,r)}return r}function G0(e,t,n){e.flags|=16384,e={getSnapshot:t,value:n},t=bt.updateQueue,t===null?(t={lastEffect:null,stores:null},bt.updateQueue=t,t.stores=[e]):(n=t.stores,n===null?t.stores=[e]:n.push(e))}function q0(e,t,n,o){t.value=n,t.getSnapshot=o,J0(t)&&eh(e)}function Z0(e,t,n){return n(function(){J0(t)&&eh(e)})}function J0(e){var t=e.getSnapshot;e=e.value;try{var n=t();return!Zn(e,n)}catch{return!0}}function eh(e){var t=Lo(e,1);t!==null&&qn(t,e,1,-1)}function bf(e){var t=co();return typeof e=="function"&&(e=e()),t.memoizedState=t.baseState=e,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:wi,lastRenderedState:e},t.queue=e,e=e.dispatch=ug.bind(null,bt,e),[t.memoizedState,e]}function bi(e,t,n,o){return e={tag:e,create:t,destroy:n,deps:o,next:null},t=bt.updateQueue,t===null?(t={lastEffect:null,stores:null},bt.updateQueue=t,t.lastEffect=e.next=e):(n=t.lastEffect,n===null?t.lastEffect=e.next=e:(o=n.next,n.next=e,e.next=o,t.lastEffect=e)),e}function th(){return zn().memoizedState}function Es(e,t,n,o){var r=co();bt.flags|=e,r.memoizedState=bi(1|t,n,void 0,o===void 0?null:o)}function aa(e,t,n,o){var r=zn();o=o===void 0?null:o;var l=void 0;if(At!==null){var i=At.memoizedState;if(l=i.destroy,o!==null&&qd(o,i.deps)){r.memoizedState=bi(t,n,l,o);return}}bt.flags|=e,r.memoizedState=bi(1|t,n,l,o)}function kf(e,t){return Es(8390656,8,e,t)}function eu(e,t){return aa(2048,8,e,t)}function nh(e,t){return aa(4,2,e,t)}function oh(e,t){return aa(4,4,e,t)}function rh(e,t){if(typeof t=="function")return e=e(),t(e),function(){t(null)};if(t!=null)return e=e(),t.current=e,function(){t.current=null}}function lh(e,t,n){return n=n!=null?n.concat([e]):null,aa(4,4,rh.bind(null,t,e),n)}function tu(){}function ih(e,t){var n=zn();t=t===void 0?null:t;var o=n.memoizedState;return o!==null&&t!==null&&qd(t,o[1])?o[0]:(n.memoizedState=[e,t],e)}function sh(e,t){var n=zn();t=t===void 0?null:t;var o=n.memoizedState;return o!==null&&t!==null&&qd(t,o[1])?o[0]:(e=e(),n.memoizedState=[e,t],e)}function ah(e,t,n){return(br&21)===0?(e.baseState&&(e.baseState=!1,fn=!0),e.memoizedState=n):(Zn(n,t)||(n=f0(),bt.lanes|=n,kr|=n,e.baseState=!0),t)}function cg(e,t){var n=rt;rt=n!==0&&4>n?n:4,e(!0);var o=Sc.transition;Sc.transition={};try{e(!1),t()}finally{rt=n,Sc.transition=o}}function ch(){return zn().memoizedState}function dg(e,t,n){var o=Go(e);if(n={lane:o,action:n,hasEagerState:!1,eagerState:null,next:null},dh(e))uh(t,n);else if(n=Y0(e,t,n,o),n!==null){var r=on();qn(n,e,o,r),_h(n,t,o)}}function ug(e,t,n){var o=Go(e),r={lane:o,action:n,hasEagerState:!1,eagerState:null,next:null};if(dh(e))uh(t,r);else{var l=e.alternate;if(e.lanes===0&&(l===null||l.lanes===0)&&(l=t.lastRenderedReducer,l!==null))try{var i=t.lastRenderedState,s=l(i,n);if(r.hasEagerState=!0,r.eagerState=s,Zn(s,i)){var a=t.interleaved;a===null?(r.next=r,Xd(t)):(r.next=a.next,a.next=r),t.interleaved=r;return}}catch{}n=Y0(e,t,r,o),n!==null&&(r=on(),qn(n,e,o,r),_h(n,t,o))}}function dh(e){var t=e.alternate;return e===bt||t!==null&&t===bt}function uh(e,t){oi=Ks=!0;var n=e.pending;n===null?t.next=t:(t.next=n.next,n.next=t),e.pending=t}function _h(e,t,n){if((n&4194240)!==0){var o=t.lanes;o&=e.pendingLanes,n|=o,t.lanes=n,Rd(e,n)}}var Gs={readContext:Bn,useCallback:Gt,useContext:Gt,useEffect:Gt,useImperativeHandle:Gt,useInsertionEffect:Gt,useLayoutEffect:Gt,useMemo:Gt,useReducer:Gt,useRef:Gt,useState:Gt,useDebugValue:Gt,useDeferredValue:Gt,useTransition:Gt,useMutableSource:Gt,useSyncExternalStore:Gt,useId:Gt,unstable_isNewReconciler:!1},_g={readContext:Bn,useCallback:function(e,t){return co().memoizedState=[e,t===void 0?null:t],e},useContext:Bn,useEffect:kf,useImperativeHandle:function(e,t,n){return n=n!=null?n.concat([e]):null,Es(4194308,4,rh.bind(null,t,e),n)},useLayoutEffect:function(e,t){return Es(4194308,4,e,t)},useInsertionEffect:function(e,t){return Es(4,2,e,t)},useMemo:function(e,t){var n=co();return t=t===void 0?null:t,e=e(),n.memoizedState=[e,t],e},useReducer:function(e,t,n){var o=co();return t=n!==void 0?n(t):t,o.memoizedState=o.baseState=t,e={pending:null,interleaved:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:t},o.queue=e,e=e.dispatch=dg.bind(null,bt,e),[o.memoizedState,e]},useRef:function(e){var t=co();return e={current:e},t.memoizedState=e},useState:bf,useDebugValue:tu,useDeferredValue:function(e){return co().memoizedState=e},useTransition:function(){var e=bf(!1),t=e[0];return e=cg.bind(null,e[1]),co().memoizedState=e,[t,e]},useMutableSource:function(){},useSyncExternalStore:function(e,t,n){var o=bt,r=co();if(gt){if(n===void 0)throw Error(j(407));n=n()}else{if(n=t(),Ht===null)throw Error(j(349));(br&30)!==0||G0(o,t,n)}r.memoizedState=n;var l={value:n,getSnapshot:t};return r.queue=l,kf(Z0.bind(null,o,l,e),[e]),o.flags|=2048,bi(9,q0.bind(null,o,l,n,t),void 0,null),n},useId:function(){var e=co(),t=Ht.identifierPrefix;if(gt){var n=Co,o=ko;n=(o&~(1<<32-Gn(o)-1)).toString(32)+n,t=":"+t+"R"+n,n=vi++,0<n&&(t+="H"+n.toString(32)),t+=":"}else n=ag++,t=":"+t+"r"+n.toString(32)+":";return e.memoizedState=t},unstable_isNewReconciler:!1},fg={readContext:Bn,useCallback:ih,useContext:Bn,useEffect:eu,useImperativeHandle:lh,useInsertionEffect:nh,useLayoutEffect:oh,useMemo:sh,useReducer:Mc,useRef:th,useState:function(){return Mc(wi)},useDebugValue:tu,useDeferredValue:function(e){var t=zn();return ah(t,At.memoizedState,e)},useTransition:function(){var e=Mc(wi)[0],t=zn().memoizedState;return[e,t]},useMutableSource:V0,useSyncExternalStore:K0,useId:ch,unstable_isNewReconciler:!1},hg={readContext:Bn,useCallback:ih,useContext:Bn,useEffect:eu,useImperativeHandle:lh,useInsertionEffect:nh,useLayoutEffect:oh,useMemo:sh,useReducer:Ec,useRef:th,useState:function(){return Ec(wi)},useDebugValue:tu,useDeferredValue:function(e){var t=zn();return At===null?t.memoizedState=e:ah(t,At.memoizedState,e)},useTransition:function(){var e=Ec(wi)[0],t=zn().memoizedState;return[e,t]},useMutableSource:V0,useSyncExternalStore:K0,useId:ch,unstable_isNewReconciler:!1};function Qn(e,t){if(e&&e.defaultProps){t=kt({},t),e=e.defaultProps;for(var n in e)t[n]===void 0&&(t[n]=e[n]);return t}return t}function ad(e,t,n,o){t=e.memoizedState,n=n(o,t),n=n==null?t:kt({},t,n),e.memoizedState=n,e.lanes===0&&(e.updateQueue.baseState=n)}var ca={isMounted:function(e){return(e=e._reactInternals)?Mr(e)===e:!1},enqueueSetState:function(e,t,n){e=e._reactInternals;var o=on(),r=Go(e),l=So(o,r);l.payload=t,n!=null&&(l.callback=n),t=Vo(e,l,r),t!==null&&(qn(t,e,r,o),Ss(t,e,r))},enqueueReplaceState:function(e,t,n){e=e._reactInternals;var o=on(),r=Go(e),l=So(o,r);l.tag=1,l.payload=t,n!=null&&(l.callback=n),t=Vo(e,l,r),t!==null&&(qn(t,e,r,o),Ss(t,e,r))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var n=on(),o=Go(e),r=So(n,o);r.tag=2,t!=null&&(r.callback=t),t=Vo(e,r,o),t!==null&&(qn(t,e,o,n),Ss(t,e,o))}};function Cf(e,t,n,o,r,l,i){return e=e.stateNode,typeof e.shouldComponentUpdate=="function"?e.shouldComponentUpdate(o,l,i):t.prototype&&t.prototype.isPureReactComponent?!hi(n,o)||!hi(r,l):!0}function fh(e,t,n){var o=!1,r=Jo,l=t.contextType;return typeof l=="object"&&l!==null?l=Bn(l):(r=pn(t)?vr:Jt.current,o=t.contextTypes,l=(o=o!=null)?cl(e,r):Jo),t=new t(n,l),e.memoizedState=t.state!==null&&t.state!==void 0?t.state:null,t.updater=ca,e.stateNode=t,t._reactInternals=e,o&&(e=e.stateNode,e.__reactInternalMemoizedUnmaskedChildContext=r,e.__reactInternalMemoizedMaskedChildContext=l),t}function Sf(e,t,n,o){e=t.state,typeof t.componentWillReceiveProps=="function"&&t.componentWillReceiveProps(n,o),typeof t.UNSAFE_componentWillReceiveProps=="function"&&t.UNSAFE_componentWillReceiveProps(n,o),t.state!==e&&ca.enqueueReplaceState(t,t.state,null)}function cd(e,t,n,o){var r=e.stateNode;r.props=n,r.state=e.memoizedState,r.refs={},Qd(e);var l=t.contextType;typeof l=="object"&&l!==null?r.context=Bn(l):(l=pn(t)?vr:Jt.current,r.context=cl(e,l)),r.state=e.memoizedState,l=t.getDerivedStateFromProps,typeof l=="function"&&(ad(e,t,l,n),r.state=e.memoizedState),typeof t.getDerivedStateFromProps=="function"||typeof r.getSnapshotBeforeUpdate=="function"||typeof r.UNSAFE_componentWillMount!="function"&&typeof r.componentWillMount!="function"||(t=r.state,typeof r.componentWillMount=="function"&&r.componentWillMount(),typeof r.UNSAFE_componentWillMount=="function"&&r.UNSAFE_componentWillMount(),t!==r.state&&ca.enqueueReplaceState(r,r.state,null),Qs(e,n,r,o),r.state=e.memoizedState),typeof r.componentDidMount=="function"&&(e.flags|=4194308)}function fl(e,t){try{var n="",o=t;do n+=Um(o),o=o.return;while(o);var r=n}catch(l){r=`
Error generating stack: `+l.message+`
`+l.stack}return{value:e,source:t,stack:r,digest:null}}function Lc(e,t,n){return{value:e,source:null,stack:n??null,digest:t??null}}function dd(e,t){try{console.error(t.value)}catch(n){setTimeout(function(){throw n})}}var pg=typeof WeakMap=="function"?WeakMap:Map;function hh(e,t,n){n=So(-1,n),n.tag=3,n.payload={element:null};var o=t.value;return n.callback=function(){Zs||(Zs=!0,vd=o),dd(e,t)},n}function ph(e,t,n){n=So(-1,n),n.tag=3;var o=e.type.getDerivedStateFromError;if(typeof o=="function"){var r=t.value;n.payload=function(){return o(r)},n.callback=function(){dd(e,t)}}var l=e.stateNode;return l!==null&&typeof l.componentDidCatch=="function"&&(n.callback=function(){dd(e,t),typeof o!="function"&&(Ko===null?Ko=new Set([this]):Ko.add(this));var i=t.stack;this.componentDidCatch(t.value,{componentStack:i!==null?i:""})}),n}function Mf(e,t,n){var o=e.pingCache;if(o===null){o=e.pingCache=new pg;var r=new Set;o.set(t,r)}else r=o.get(t),r===void 0&&(r=new Set,o.set(t,r));r.has(n)||(r.add(n),e=Ig.bind(null,e,t,n),t.then(e,e))}function Ef(e){do{var t;if((t=e.tag===13)&&(t=e.memoizedState,t=t!==null?t.dehydrated!==null:!0),t)return e;e=e.return}while(e!==null);return null}function Lf(e,t,n,o,r){return(e.mode&1)===0?(e===t?e.flags|=65536:(e.flags|=128,n.flags|=131072,n.flags&=-52805,n.tag===1&&(n.alternate===null?n.tag=17:(t=So(-1,1),t.tag=2,Vo(n,t,1))),n.lanes|=1),e):(e.flags|=65536,e.lanes=r,e)}var mg=No.ReactCurrentOwner,fn=!1;function nn(e,t,n,o){t.child=e===null?U0(t,null,n,o):ul(t,e.child,n,o)}function If(e,t,n,o,r){n=n.render;var l=t.ref;return il(t,r),o=Zd(e,t,n,o,l,r),n=Jd(),e!==null&&!fn?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~r,Io(e,t,r)):(gt&&n&&Wd(t),t.flags|=1,nn(e,t,o,r),t.child)}function Nf(e,t,n,o,r){if(e===null){var l=n.type;return typeof l=="function"&&!cu(l)&&l.defaultProps===void 0&&n.compare===null&&n.defaultProps===void 0?(t.tag=15,t.type=l,mh(e,t,l,o,r)):(e=$s(n.type,null,o,t,t.mode,r),e.ref=t.ref,e.return=t,t.child=e)}if(l=e.child,(e.lanes&r)===0){var i=l.memoizedProps;if(n=n.compare,n=n!==null?n:hi,n(i,o)&&e.ref===t.ref)return Io(e,t,r)}return t.flags|=1,e=qo(l,o),e.ref=t.ref,e.return=t,t.child=e}function mh(e,t,n,o,r){if(e!==null){var l=e.memoizedProps;if(hi(l,o)&&e.ref===t.ref)if(fn=!1,t.pendingProps=o=l,(e.lanes&r)!==0)(e.flags&131072)!==0&&(fn=!0);else return t.lanes=e.lanes,Io(e,t,r)}return ud(e,t,n,o,r)}function gh(e,t,n){var o=t.pendingProps,r=o.children,l=e!==null?e.memoizedState:null;if(o.mode==="hidden")if((t.mode&1)===0)t.memoizedState={baseLanes:0,cachePool:null,transitions:null},ht(tl,yn),yn|=n;else{if((n&1073741824)===0)return e=l!==null?l.baseLanes|n:n,t.lanes=t.childLanes=1073741824,t.memoizedState={baseLanes:e,cachePool:null,transitions:null},t.updateQueue=null,ht(tl,yn),yn|=e,null;t.memoizedState={baseLanes:0,cachePool:null,transitions:null},o=l!==null?l.baseLanes:n,ht(tl,yn),yn|=o}else l!==null?(o=l.baseLanes|n,t.memoizedState=null):o=n,ht(tl,yn),yn|=o;return nn(e,t,r,n),t.child}function yh(e,t){var n=t.ref;(e===null&&n!==null||e!==null&&e.ref!==n)&&(t.flags|=512,t.flags|=2097152)}function ud(e,t,n,o,r){var l=pn(n)?vr:Jt.current;return l=cl(t,l),il(t,r),n=Zd(e,t,n,o,l,r),o=Jd(),e!==null&&!fn?(t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~r,Io(e,t,r)):(gt&&o&&Wd(t),t.flags|=1,nn(e,t,n,r),t.child)}function $f(e,t,n,o,r){if(pn(n)){var l=!0;js(t)}else l=!1;if(il(t,r),t.stateNode===null)Ls(e,t),fh(t,n,o),cd(t,n,o,r),o=!0;else if(e===null){var i=t.stateNode,s=t.memoizedProps;i.props=s;var a=i.context,m=n.contextType;typeof m=="object"&&m!==null?m=Bn(m):(m=pn(n)?vr:Jt.current,m=cl(t,m));var p=n.getDerivedStateFromProps,b=typeof p=="function"||typeof i.getSnapshotBeforeUpdate=="function";b||typeof i.UNSAFE_componentWillReceiveProps!="function"&&typeof i.componentWillReceiveProps!="function"||(s!==o||a!==m)&&Sf(t,i,o,m),Ao=!1;var y=t.memoizedState;i.state=y,Qs(t,o,i,r),a=t.memoizedState,s!==o||y!==a||hn.current||Ao?(typeof p=="function"&&(ad(t,n,p,o),a=t.memoizedState),(s=Ao||Cf(t,n,s,o,y,a,m))?(b||typeof i.UNSAFE_componentWillMount!="function"&&typeof i.componentWillMount!="function"||(typeof i.componentWillMount=="function"&&i.componentWillMount(),typeof i.UNSAFE_componentWillMount=="function"&&i.UNSAFE_componentWillMount()),typeof i.componentDidMount=="function"&&(t.flags|=4194308)):(typeof i.componentDidMount=="function"&&(t.flags|=4194308),t.memoizedProps=o,t.memoizedState=a),i.props=o,i.state=a,i.context=m,o=s):(typeof i.componentDidMount=="function"&&(t.flags|=4194308),o=!1)}else{i=t.stateNode,X0(e,t),s=t.memoizedProps,m=t.type===t.elementType?s:Qn(t.type,s),i.props=m,b=t.pendingProps,y=i.context,a=n.contextType,typeof a=="object"&&a!==null?a=Bn(a):(a=pn(n)?vr:Jt.current,a=cl(t,a));var $=n.getDerivedStateFromProps;(p=typeof $=="function"||typeof i.getSnapshotBeforeUpdate=="function")||typeof i.UNSAFE_componentWillReceiveProps!="function"&&typeof i.componentWillReceiveProps!="function"||(s!==b||y!==a)&&Sf(t,i,o,a),Ao=!1,y=t.memoizedState,i.state=y,Qs(t,o,i,r);var C=t.memoizedState;s!==b||y!==C||hn.current||Ao?(typeof $=="function"&&(ad(t,n,$,o),C=t.memoizedState),(m=Ao||Cf(t,n,m,o,y,C,a)||!1)?(p||typeof i.UNSAFE_componentWillUpdate!="function"&&typeof i.componentWillUpdate!="function"||(typeof i.componentWillUpdate=="function"&&i.componentWillUpdate(o,C,a),typeof i.UNSAFE_componentWillUpdate=="function"&&i.UNSAFE_componentWillUpdate(o,C,a)),typeof i.componentDidUpdate=="function"&&(t.flags|=4),typeof i.getSnapshotBeforeUpdate=="function"&&(t.flags|=1024)):(typeof i.componentDidUpdate!="function"||s===e.memoizedProps&&y===e.memoizedState||(t.flags|=4),typeof i.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&y===e.memoizedState||(t.flags|=1024),t.memoizedProps=o,t.memoizedState=C),i.props=o,i.state=C,i.context=a,o=m):(typeof i.componentDidUpdate!="function"||s===e.memoizedProps&&y===e.memoizedState||(t.flags|=4),typeof i.getSnapshotBeforeUpdate!="function"||s===e.memoizedProps&&y===e.memoizedState||(t.flags|=1024),o=!1)}return _d(e,t,n,o,l,r)}function _d(e,t,n,o,r,l){yh(e,t);var i=(t.flags&128)!==0;if(!o&&!i)return r&&mf(t,n,!1),Io(e,t,l);o=t.stateNode,mg.current=t;var s=i&&typeof n.getDerivedStateFromError!="function"?null:o.render();return t.flags|=1,e!==null&&i?(t.child=ul(t,e.child,null,l),t.child=ul(t,null,s,l)):nn(e,t,s,l),t.memoizedState=o.state,r&&mf(t,n,!0),t.child}function xh(e){var t=e.stateNode;t.pendingContext?pf(e,t.pendingContext,t.pendingContext!==t.context):t.context&&pf(e,t.context,!1),Vd(e,t.containerInfo)}function Rf(e,t,n,o,r){return dl(),jd(r),t.flags|=256,nn(e,t,n,o),t.child}var fd={dehydrated:null,treeContext:null,retryLane:0};function hd(e){return{baseLanes:e,cachePool:null,transitions:null}}function vh(e,t,n){var o=t.pendingProps,r=wt.current,l=!1,i=(t.flags&128)!==0,s;if((s=i)||(s=e!==null&&e.memoizedState===null?!1:(r&2)!==0),s?(l=!0,t.flags&=-129):(e===null||e.memoizedState!==null)&&(r|=1),ht(wt,r&1),e===null)return id(t),e=t.memoizedState,e!==null&&(e=e.dehydrated,e!==null)?((t.mode&1)===0?t.lanes=1:e.data==="$!"?t.lanes=8:t.lanes=1073741824,null):(i=o.children,e=o.fallback,l?(o=t.mode,l=t.child,i={mode:"hidden",children:i},(o&1)===0&&l!==null?(l.childLanes=0,l.pendingProps=i):l=_a(i,o,0,null),e=xr(e,o,n,null),l.return=t,e.return=t,l.sibling=e,t.child=l,t.child.memoizedState=hd(n),t.memoizedState=fd,e):nu(t,i));if(r=e.memoizedState,r!==null&&(s=r.dehydrated,s!==null))return gg(e,t,i,o,s,r,n);if(l){l=o.fallback,i=t.mode,r=e.child,s=r.sibling;var a={mode:"hidden",children:o.children};return(i&1)===0&&t.child!==r?(o=t.child,o.childLanes=0,o.pendingProps=a,t.deletions=null):(o=qo(r,a),o.subtreeFlags=r.subtreeFlags&14680064),s!==null?l=qo(s,l):(l=xr(l,i,n,null),l.flags|=2),l.return=t,o.return=t,o.sibling=l,t.child=o,o=l,l=t.child,i=e.child.memoizedState,i=i===null?hd(n):{baseLanes:i.baseLanes|n,cachePool:null,transitions:i.transitions},l.memoizedState=i,l.childLanes=e.childLanes&~n,t.memoizedState=fd,o}return l=e.child,e=l.sibling,o=qo(l,{mode:"visible",children:o.children}),(t.mode&1)===0&&(o.lanes=n),o.return=t,o.sibling=null,e!==null&&(n=t.deletions,n===null?(t.deletions=[e],t.flags|=16):n.push(e)),t.child=o,t.memoizedState=null,o}function nu(e,t){return t=_a({mode:"visible",children:t},e.mode,0,null),t.return=e,e.child=t}function xs(e,t,n,o){return o!==null&&jd(o),ul(t,e.child,null,n),e=nu(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function gg(e,t,n,o,r,l,i){if(n)return t.flags&256?(t.flags&=-257,o=Lc(Error(j(422))),xs(e,t,i,o)):t.memoizedState!==null?(t.child=e.child,t.flags|=128,null):(l=o.fallback,r=t.mode,o=_a({mode:"visible",children:o.children},r,0,null),l=xr(l,r,i,null),l.flags|=2,o.return=t,l.return=t,o.sibling=l,t.child=o,(t.mode&1)!==0&&ul(t,e.child,null,i),t.child.memoizedState=hd(i),t.memoizedState=fd,l);if((t.mode&1)===0)return xs(e,t,i,null);if(r.data==="$!"){if(o=r.nextSibling&&r.nextSibling.dataset,o)var s=o.dgst;return o=s,l=Error(j(419)),o=Lc(l,o,void 0),xs(e,t,i,o)}if(s=(i&e.childLanes)!==0,fn||s){if(o=Ht,o!==null){switch(i&-i){case 4:r=2;break;case 16:r=8;break;case 64:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:case 67108864:r=32;break;case 536870912:r=268435456;break;default:r=0}r=(r&(o.suspendedLanes|i))!==0?0:r,r!==0&&r!==l.retryLane&&(l.retryLane=r,Lo(e,r),qn(o,e,r,-1))}return au(),o=Lc(Error(j(421))),xs(e,t,i,o)}return r.data==="$?"?(t.flags|=128,t.child=e.child,t=Ng.bind(null,e),r._reactRetry=t,null):(e=l.treeContext,xn=Qo(r.nextSibling),vn=t,gt=!0,Kn=null,e!==null&&(Rn[Tn++]=ko,Rn[Tn++]=Co,Rn[Tn++]=wr,ko=e.id,Co=e.overflow,wr=t),t=nu(t,o.children),t.flags|=4096,t)}function Tf(e,t,n){e.lanes|=t;var o=e.alternate;o!==null&&(o.lanes|=t),sd(e.return,t,n)}function Ic(e,t,n,o,r){var l=e.memoizedState;l===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:o,tail:n,tailMode:r}:(l.isBackwards=t,l.rendering=null,l.renderingStartTime=0,l.last=o,l.tail=n,l.tailMode=r)}function wh(e,t,n){var o=t.pendingProps,r=o.revealOrder,l=o.tail;if(nn(e,t,o.children,n),o=wt.current,(o&2)!==0)o=o&1|2,t.flags|=128;else{if(e!==null&&(e.flags&128)!==0)e:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&Tf(e,n,t);else if(e.tag===19)Tf(e,n,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break e;for(;e.sibling===null;){if(e.return===null||e.return===t)break e;e=e.return}e.sibling.return=e.return,e=e.sibling}o&=1}if(ht(wt,o),(t.mode&1)===0)t.memoizedState=null;else switch(r){case"forwards":for(n=t.child,r=null;n!==null;)e=n.alternate,e!==null&&Vs(e)===null&&(r=n),n=n.sibling;n=r,n===null?(r=t.child,t.child=null):(r=n.sibling,n.sibling=null),Ic(t,!1,r,n,l);break;case"backwards":for(n=null,r=t.child,t.child=null;r!==null;){if(e=r.alternate,e!==null&&Vs(e)===null){t.child=r;break}e=r.sibling,r.sibling=n,n=r,r=e}Ic(t,!0,n,null,l);break;case"together":Ic(t,!1,null,null,void 0);break;default:t.memoizedState=null}return t.child}function Ls(e,t){(t.mode&1)===0&&e!==null&&(e.alternate=null,t.alternate=null,t.flags|=2)}function Io(e,t,n){if(e!==null&&(t.dependencies=e.dependencies),kr|=t.lanes,(n&t.childLanes)===0)return null;if(e!==null&&t.child!==e.child)throw Error(j(153));if(t.child!==null){for(e=t.child,n=qo(e,e.pendingProps),t.child=n,n.return=t;e.sibling!==null;)e=e.sibling,n=n.sibling=qo(e,e.pendingProps),n.return=t;n.sibling=null}return t.child}function yg(e,t,n){switch(t.tag){case 3:xh(t),dl();break;case 5:Q0(t);break;case 1:pn(t.type)&&js(t);break;case 4:Vd(t,t.stateNode.containerInfo);break;case 10:var o=t.type._context,r=t.memoizedProps.value;ht(Ys,o._currentValue),o._currentValue=r;break;case 13:if(o=t.memoizedState,o!==null)return o.dehydrated!==null?(ht(wt,wt.current&1),t.flags|=128,null):(n&t.child.childLanes)!==0?vh(e,t,n):(ht(wt,wt.current&1),e=Io(e,t,n),e!==null?e.sibling:null);ht(wt,wt.current&1);break;case 19:if(o=(n&t.childLanes)!==0,(e.flags&128)!==0){if(o)return wh(e,t,n);t.flags|=128}if(r=t.memoizedState,r!==null&&(r.rendering=null,r.tail=null,r.lastEffect=null),ht(wt,wt.current),o)break;return null;case 22:case 23:return t.lanes=0,gh(e,t,n)}return Io(e,t,n)}var bh,pd,kh,Ch;bh=function(e,t){for(var n=t.child;n!==null;){if(n.tag===5||n.tag===6)e.appendChild(n.stateNode);else if(n.tag!==4&&n.child!==null){n.child.return=n,n=n.child;continue}if(n===t)break;for(;n.sibling===null;){if(n.return===null||n.return===t)return;n=n.return}n.sibling.return=n.return,n=n.sibling}};pd=function(){};kh=function(e,t,n,o){var r=e.memoizedProps;if(r!==o){e=t.stateNode,gr(fo.current);var l=null;switch(n){case"input":r=zc(e,r),o=zc(e,o),l=[];break;case"select":r=kt({},r,{value:void 0}),o=kt({},o,{value:void 0}),l=[];break;case"textarea":r=Wc(e,r),o=Wc(e,o),l=[];break;default:typeof r.onClick!="function"&&typeof o.onClick=="function"&&(e.onclick=Ws)}jc(n,o);var i;n=null;for(m in r)if(!o.hasOwnProperty(m)&&r.hasOwnProperty(m)&&r[m]!=null)if(m==="style"){var s=r[m];for(i in s)s.hasOwnProperty(i)&&(n||(n={}),n[i]="")}else m!=="dangerouslySetInnerHTML"&&m!=="children"&&m!=="suppressContentEditableWarning"&&m!=="suppressHydrationWarning"&&m!=="autoFocus"&&(si.hasOwnProperty(m)?l||(l=[]):(l=l||[]).push(m,null));for(m in o){var a=o[m];if(s=r?.[m],o.hasOwnProperty(m)&&a!==s&&(a!=null||s!=null))if(m==="style")if(s){for(i in s)!s.hasOwnProperty(i)||a&&a.hasOwnProperty(i)||(n||(n={}),n[i]="");for(i in a)a.hasOwnProperty(i)&&s[i]!==a[i]&&(n||(n={}),n[i]=a[i])}else n||(l||(l=[]),l.push(m,n)),n=a;else m==="dangerouslySetInnerHTML"?(a=a?a.__html:void 0,s=s?s.__html:void 0,a!=null&&s!==a&&(l=l||[]).push(m,a)):m==="children"?typeof a!="string"&&typeof a!="number"||(l=l||[]).push(m,""+a):m!=="suppressContentEditableWarning"&&m!=="suppressHydrationWarning"&&(si.hasOwnProperty(m)?(a!=null&&m==="onScroll"&&pt("scroll",e),l||s===a||(l=[])):(l=l||[]).push(m,a))}n&&(l=l||[]).push("style",n);var m=l;(t.updateQueue=m)&&(t.flags|=4)}};Ch=function(e,t,n,o){n!==o&&(t.flags|=4)};function Yl(e,t){if(!gt)switch(e.tailMode){case"hidden":t=e.tail;for(var n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?e.tail=null:n.sibling=null;break;case"collapsed":n=e.tail;for(var o=null;n!==null;)n.alternate!==null&&(o=n),n=n.sibling;o===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:o.sibling=null}}function qt(e){var t=e.alternate!==null&&e.alternate.child===e.child,n=0,o=0;if(t)for(var r=e.child;r!==null;)n|=r.lanes|r.childLanes,o|=r.subtreeFlags&14680064,o|=r.flags&14680064,r.return=e,r=r.sibling;else for(r=e.child;r!==null;)n|=r.lanes|r.childLanes,o|=r.subtreeFlags,o|=r.flags,r.return=e,r=r.sibling;return e.subtreeFlags|=o,e.childLanes=n,t}function xg(e,t,n){var o=t.pendingProps;switch(Fd(t),t.tag){case 2:case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return qt(t),null;case 1:return pn(t.type)&&Fs(),qt(t),null;case 3:return o=t.stateNode,_l(),mt(hn),mt(Jt),Gd(),o.pendingContext&&(o.context=o.pendingContext,o.pendingContext=null),(e===null||e.child===null)&&(gs(t)?t.flags|=4:e===null||e.memoizedState.isDehydrated&&(t.flags&256)===0||(t.flags|=1024,Kn!==null&&(kd(Kn),Kn=null))),pd(e,t),qt(t),null;case 5:Kd(t);var r=gr(xi.current);if(n=t.type,e!==null&&t.stateNode!=null)kh(e,t,n,o,r),e.ref!==t.ref&&(t.flags|=512,t.flags|=2097152);else{if(!o){if(t.stateNode===null)throw Error(j(166));return qt(t),null}if(e=gr(fo.current),gs(t)){o=t.stateNode,n=t.type;var l=t.memoizedProps;switch(o[uo]=t,o[gi]=l,e=(t.mode&1)!==0,n){case"dialog":pt("cancel",o),pt("close",o);break;case"iframe":case"object":case"embed":pt("load",o);break;case"video":case"audio":for(r=0;r<ql.length;r++)pt(ql[r],o);break;case"source":pt("error",o);break;case"img":case"image":case"link":pt("error",o),pt("load",o);break;case"details":pt("toggle",o);break;case"input":W_(o,l),pt("invalid",o);break;case"select":o._wrapperState={wasMultiple:!!l.multiple},pt("invalid",o);break;case"textarea":j_(o,l),pt("invalid",o)}jc(n,l),r=null;for(var i in l)if(l.hasOwnProperty(i)){var s=l[i];i==="children"?typeof s=="string"?o.textContent!==s&&(l.suppressHydrationWarning!==!0&&ms(o.textContent,s,e),r=["children",s]):typeof s=="number"&&o.textContent!==""+s&&(l.suppressHydrationWarning!==!0&&ms(o.textContent,s,e),r=["children",""+s]):si.hasOwnProperty(i)&&s!=null&&i==="onScroll"&&pt("scroll",o)}switch(n){case"input":rs(o),F_(o,l,!0);break;case"textarea":rs(o),H_(o);break;case"select":case"option":break;default:typeof l.onClick=="function"&&(o.onclick=Ws)}o=r,t.updateQueue=o,o!==null&&(t.flags|=4)}else{i=r.nodeType===9?r:r.ownerDocument,e==="http://www.w3.org/1999/xhtml"&&(e=Zf(n)),e==="http://www.w3.org/1999/xhtml"?n==="script"?(e=i.createElement("div"),e.innerHTML="<script><\/script>",e=e.removeChild(e.firstChild)):typeof o.is=="string"?e=i.createElement(n,{is:o.is}):(e=i.createElement(n),n==="select"&&(i=e,o.multiple?i.multiple=!0:o.size&&(i.size=o.size))):e=i.createElementNS(e,n),e[uo]=t,e[gi]=o,bh(e,t,!1,!1),t.stateNode=e;e:{switch(i=Hc(n,o),n){case"dialog":pt("cancel",e),pt("close",e),r=o;break;case"iframe":case"object":case"embed":pt("load",e),r=o;break;case"video":case"audio":for(r=0;r<ql.length;r++)pt(ql[r],e);r=o;break;case"source":pt("error",e),r=o;break;case"img":case"image":case"link":pt("error",e),pt("load",e),r=o;break;case"details":pt("toggle",e),r=o;break;case"input":W_(e,o),r=zc(e,o),pt("invalid",e);break;case"option":r=o;break;case"select":e._wrapperState={wasMultiple:!!o.multiple},r=kt({},o,{value:void 0}),pt("invalid",e);break;case"textarea":j_(e,o),r=Wc(e,o),pt("invalid",e);break;default:r=o}jc(n,r),s=r;for(l in s)if(s.hasOwnProperty(l)){var a=s[l];l==="style"?t0(e,a):l==="dangerouslySetInnerHTML"?(a=a?a.__html:void 0,a!=null&&Jf(e,a)):l==="children"?typeof a=="string"?(n!=="textarea"||a!=="")&&ai(e,a):typeof a=="number"&&ai(e,""+a):l!=="suppressContentEditableWarning"&&l!=="suppressHydrationWarning"&&l!=="autoFocus"&&(si.hasOwnProperty(l)?a!=null&&l==="onScroll"&&pt("scroll",e):a!=null&&Md(e,l,a,i))}switch(n){case"input":rs(e),F_(e,o,!1);break;case"textarea":rs(e),H_(e);break;case"option":o.value!=null&&e.setAttribute("value",""+Zo(o.value));break;case"select":e.multiple=!!o.multiple,l=o.value,l!=null?nl(e,!!o.multiple,l,!1):o.defaultValue!=null&&nl(e,!!o.multiple,o.defaultValue,!0);break;default:typeof r.onClick=="function"&&(e.onclick=Ws)}switch(n){case"button":case"input":case"select":case"textarea":o=!!o.autoFocus;break e;case"img":o=!0;break e;default:o=!1}}o&&(t.flags|=4)}t.ref!==null&&(t.flags|=512,t.flags|=2097152)}return qt(t),null;case 6:if(e&&t.stateNode!=null)Ch(e,t,e.memoizedProps,o);else{if(typeof o!="string"&&t.stateNode===null)throw Error(j(166));if(n=gr(xi.current),gr(fo.current),gs(t)){if(o=t.stateNode,n=t.memoizedProps,o[uo]=t,(l=o.nodeValue!==n)&&(e=vn,e!==null))switch(e.tag){case 3:ms(o.nodeValue,n,(e.mode&1)!==0);break;case 5:e.memoizedProps.suppressHydrationWarning!==!0&&ms(o.nodeValue,n,(e.mode&1)!==0)}l&&(t.flags|=4)}else o=(n.nodeType===9?n:n.ownerDocument).createTextNode(o),o[uo]=t,t.stateNode=o}return qt(t),null;case 13:if(mt(wt),o=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(gt&&xn!==null&&(t.mode&1)!==0&&(t.flags&128)===0)j0(),dl(),t.flags|=98560,l=!1;else if(l=gs(t),o!==null&&o.dehydrated!==null){if(e===null){if(!l)throw Error(j(318));if(l=t.memoizedState,l=l!==null?l.dehydrated:null,!l)throw Error(j(317));l[uo]=t}else dl(),(t.flags&128)===0&&(t.memoizedState=null),t.flags|=4;qt(t),l=!1}else Kn!==null&&(kd(Kn),Kn=null),l=!0;if(!l)return t.flags&65536?t:null}return(t.flags&128)!==0?(t.lanes=n,t):(o=o!==null,o!==(e!==null&&e.memoizedState!==null)&&o&&(t.child.flags|=8192,(t.mode&1)!==0&&(e===null||(wt.current&1)!==0?Wt===0&&(Wt=3):au())),t.updateQueue!==null&&(t.flags|=4),qt(t),null);case 4:return _l(),pd(e,t),e===null&&pi(t.stateNode.containerInfo),qt(t),null;case 10:return Yd(t.type._context),qt(t),null;case 17:return pn(t.type)&&Fs(),qt(t),null;case 19:if(mt(wt),l=t.memoizedState,l===null)return qt(t),null;if(o=(t.flags&128)!==0,i=l.rendering,i===null)if(o)Yl(l,!1);else{if(Wt!==0||e!==null&&(e.flags&128)!==0)for(e=t.child;e!==null;){if(i=Vs(e),i!==null){for(t.flags|=128,Yl(l,!1),o=i.updateQueue,o!==null&&(t.updateQueue=o,t.flags|=4),t.subtreeFlags=0,o=n,n=t.child;n!==null;)l=n,e=o,l.flags&=14680066,i=l.alternate,i===null?(l.childLanes=0,l.lanes=e,l.child=null,l.subtreeFlags=0,l.memoizedProps=null,l.memoizedState=null,l.updateQueue=null,l.dependencies=null,l.stateNode=null):(l.childLanes=i.childLanes,l.lanes=i.lanes,l.child=i.child,l.subtreeFlags=0,l.deletions=null,l.memoizedProps=i.memoizedProps,l.memoizedState=i.memoizedState,l.updateQueue=i.updateQueue,l.type=i.type,e=i.dependencies,l.dependencies=e===null?null:{lanes:e.lanes,firstContext:e.firstContext}),n=n.sibling;return ht(wt,wt.current&1|2),t.child}e=e.sibling}l.tail!==null&&Rt()>hl&&(t.flags|=128,o=!0,Yl(l,!1),t.lanes=4194304)}else{if(!o)if(e=Vs(i),e!==null){if(t.flags|=128,o=!0,n=e.updateQueue,n!==null&&(t.updateQueue=n,t.flags|=4),Yl(l,!0),l.tail===null&&l.tailMode==="hidden"&&!i.alternate&&!gt)return qt(t),null}else 2*Rt()-l.renderingStartTime>hl&&n!==1073741824&&(t.flags|=128,o=!0,Yl(l,!1),t.lanes=4194304);l.isBackwards?(i.sibling=t.child,t.child=i):(n=l.last,n!==null?n.sibling=i:t.child=i,l.last=i)}return l.tail!==null?(t=l.tail,l.rendering=t,l.tail=t.sibling,l.renderingStartTime=Rt(),t.sibling=null,n=wt.current,ht(wt,o?n&1|2:n&1),t):(qt(t),null);case 22:case 23:return su(),o=t.memoizedState!==null,e!==null&&e.memoizedState!==null!==o&&(t.flags|=8192),o&&(t.mode&1)!==0?(yn&1073741824)!==0&&(qt(t),t.subtreeFlags&6&&(t.flags|=8192)):qt(t),null;case 24:return null;case 25:return null}throw Error(j(156,t.tag))}function vg(e,t){switch(Fd(t),t.tag){case 1:return pn(t.type)&&Fs(),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return _l(),mt(hn),mt(Jt),Gd(),e=t.flags,(e&65536)!==0&&(e&128)===0?(t.flags=e&-65537|128,t):null;case 5:return Kd(t),null;case 13:if(mt(wt),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(j(340));dl()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return mt(wt),null;case 4:return _l(),null;case 10:return Yd(t.type._context),null;case 22:case 23:return su(),null;case 24:return null;default:return null}}var vs=!1,Zt=!1,wg=typeof WeakSet=="function"?WeakSet:Set,ne=null;function el(e,t){var n=e.ref;if(n!==null)if(typeof n=="function")try{n(null)}catch(o){Lt(e,t,o)}else n.current=null}function md(e,t,n){try{n()}catch(o){Lt(e,t,o)}}var Pf=!1;function bg(e,t){if(Jc=zs,e=I0(),Ad(e)){if("selectionStart"in e)var n={start:e.selectionStart,end:e.selectionEnd};else e:{n=(n=e.ownerDocument)&&n.defaultView||window;var o=n.getSelection&&n.getSelection();if(o&&o.rangeCount!==0){n=o.anchorNode;var r=o.anchorOffset,l=o.focusNode;o=o.focusOffset;try{n.nodeType,l.nodeType}catch{n=null;break e}var i=0,s=-1,a=-1,m=0,p=0,b=e,y=null;t:for(;;){for(var $;b!==n||r!==0&&b.nodeType!==3||(s=i+r),b!==l||o!==0&&b.nodeType!==3||(a=i+o),b.nodeType===3&&(i+=b.nodeValue.length),($=b.firstChild)!==null;)y=b,b=$;for(;;){if(b===e)break t;if(y===n&&++m===r&&(s=i),y===l&&++p===o&&(a=i),($=b.nextSibling)!==null)break;b=y,y=b.parentNode}b=$}n=s===-1||a===-1?null:{start:s,end:a}}else n=null}n=n||{start:0,end:0}}else n=null;for(ed={focusedElem:e,selectionRange:n},zs=!1,ne=t;ne!==null;)if(t=ne,e=t.child,(t.subtreeFlags&1028)!==0&&e!==null)e.return=t,ne=e;else for(;ne!==null;){t=ne;try{var C=t.alternate;if((t.flags&1024)!==0)switch(t.tag){case 0:case 11:case 15:break;case 1:if(C!==null){var I=C.memoizedProps,E=C.memoizedState,f=t.stateNode,g=f.getSnapshotBeforeUpdate(t.elementType===t.type?I:Qn(t.type,I),E);f.__reactInternalSnapshotBeforeUpdate=g}break;case 3:var w=t.stateNode.containerInfo;w.nodeType===1?w.textContent="":w.nodeType===9&&w.documentElement&&w.removeChild(w.documentElement);break;case 5:case 6:case 4:case 17:break;default:throw Error(j(163))}}catch(N){Lt(t,t.return,N)}if(e=t.sibling,e!==null){e.return=t.return,ne=e;break}ne=t.return}return C=Pf,Pf=!1,C}function ri(e,t,n){var o=t.updateQueue;if(o=o!==null?o.lastEffect:null,o!==null){var r=o=o.next;do{if((r.tag&e)===e){var l=r.destroy;r.destroy=void 0,l!==void 0&&md(t,n,l)}r=r.next}while(r!==o)}}function da(e,t){if(t=t.updateQueue,t=t!==null?t.lastEffect:null,t!==null){var n=t=t.next;do{if((n.tag&e)===e){var o=n.create;n.destroy=o()}n=n.next}while(n!==t)}}function gd(e){var t=e.ref;if(t!==null){var n=e.stateNode;e.tag,e=n,typeof t=="function"?t(e):t.current=e}}function Sh(e){var t=e.alternate;t!==null&&(e.alternate=null,Sh(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&(delete t[uo],delete t[gi],delete t[od],delete t[rg],delete t[lg])),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}function Mh(e){return e.tag===5||e.tag===3||e.tag===4}function Df(e){e:for(;;){for(;e.sibling===null;){if(e.return===null||Mh(e.return))return null;e=e.return}for(e.sibling.return=e.return,e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.flags&2||e.child===null||e.tag===4)continue e;e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function yd(e,t,n){var o=e.tag;if(o===5||o===6)e=e.stateNode,t?n.nodeType===8?n.parentNode.insertBefore(e,t):n.insertBefore(e,t):(n.nodeType===8?(t=n.parentNode,t.insertBefore(e,n)):(t=n,t.appendChild(e)),n=n._reactRootContainer,n!=null||t.onclick!==null||(t.onclick=Ws));else if(o!==4&&(e=e.child,e!==null))for(yd(e,t,n),e=e.sibling;e!==null;)yd(e,t,n),e=e.sibling}function xd(e,t,n){var o=e.tag;if(o===5||o===6)e=e.stateNode,t?n.insertBefore(e,t):n.appendChild(e);else if(o!==4&&(e=e.child,e!==null))for(xd(e,t,n),e=e.sibling;e!==null;)xd(e,t,n),e=e.sibling}var Yt=null,Vn=!1;function zo(e,t,n){for(n=n.child;n!==null;)Eh(e,t,n),n=n.sibling}function Eh(e,t,n){if(_o&&typeof _o.onCommitFiberUnmount=="function")try{_o.onCommitFiberUnmount(na,n)}catch{}switch(n.tag){case 5:Zt||el(n,t);case 6:var o=Yt,r=Vn;Yt=null,zo(e,t,n),Yt=o,Vn=r,Yt!==null&&(Vn?(e=Yt,n=n.stateNode,e.nodeType===8?e.parentNode.removeChild(n):e.removeChild(n)):Yt.removeChild(n.stateNode));break;case 18:Yt!==null&&(Vn?(e=Yt,n=n.stateNode,e.nodeType===8?bc(e.parentNode,n):e.nodeType===1&&bc(e,n),_i(e)):bc(Yt,n.stateNode));break;case 4:o=Yt,r=Vn,Yt=n.stateNode.containerInfo,Vn=!0,zo(e,t,n),Yt=o,Vn=r;break;case 0:case 11:case 14:case 15:if(!Zt&&(o=n.updateQueue,o!==null&&(o=o.lastEffect,o!==null))){r=o=o.next;do{var l=r,i=l.destroy;l=l.tag,i!==void 0&&((l&2)!==0||(l&4)!==0)&&md(n,t,i),r=r.next}while(r!==o)}zo(e,t,n);break;case 1:if(!Zt&&(el(n,t),o=n.stateNode,typeof o.componentWillUnmount=="function"))try{o.props=n.memoizedProps,o.state=n.memoizedState,o.componentWillUnmount()}catch(s){Lt(n,t,s)}zo(e,t,n);break;case 21:zo(e,t,n);break;case 22:n.mode&1?(Zt=(o=Zt)||n.memoizedState!==null,zo(e,t,n),Zt=o):zo(e,t,n);break;default:zo(e,t,n)}}function Bf(e){var t=e.updateQueue;if(t!==null){e.updateQueue=null;var n=e.stateNode;n===null&&(n=e.stateNode=new wg),t.forEach(function(o){var r=$g.bind(null,e,o);n.has(o)||(n.add(o),o.then(r,r))})}}function Xn(e,t){var n=t.deletions;if(n!==null)for(var o=0;o<n.length;o++){var r=n[o];try{var l=e,i=t,s=i;e:for(;s!==null;){switch(s.tag){case 5:Yt=s.stateNode,Vn=!1;break e;case 3:Yt=s.stateNode.containerInfo,Vn=!0;break e;case 4:Yt=s.stateNode.containerInfo,Vn=!0;break e}s=s.return}if(Yt===null)throw Error(j(160));Eh(l,i,r),Yt=null,Vn=!1;var a=r.alternate;a!==null&&(a.return=null),r.return=null}catch(m){Lt(r,t,m)}}if(t.subtreeFlags&12854)for(t=t.child;t!==null;)Lh(t,e),t=t.sibling}function Lh(e,t){var n=e.alternate,o=e.flags;switch(e.tag){case 0:case 11:case 14:case 15:if(Xn(t,e),ao(e),o&4){try{ri(3,e,e.return),da(3,e)}catch(I){Lt(e,e.return,I)}try{ri(5,e,e.return)}catch(I){Lt(e,e.return,I)}}break;case 1:Xn(t,e),ao(e),o&512&&n!==null&&el(n,n.return);break;case 5:if(Xn(t,e),ao(e),o&512&&n!==null&&el(n,n.return),e.flags&32){var r=e.stateNode;try{ai(r,"")}catch(I){Lt(e,e.return,I)}}if(o&4&&(r=e.stateNode,r!=null)){var l=e.memoizedProps,i=n!==null?n.memoizedProps:l,s=e.type,a=e.updateQueue;if(e.updateQueue=null,a!==null)try{s==="input"&&l.type==="radio"&&l.name!=null&&Gf(r,l),Hc(s,i);var m=Hc(s,l);for(i=0;i<a.length;i+=2){var p=a[i],b=a[i+1];p==="style"?t0(r,b):p==="dangerouslySetInnerHTML"?Jf(r,b):p==="children"?ai(r,b):Md(r,p,b,m)}switch(s){case"input":Oc(r,l);break;case"textarea":qf(r,l);break;case"select":var y=r._wrapperState.wasMultiple;r._wrapperState.wasMultiple=!!l.multiple;var $=l.value;$!=null?nl(r,!!l.multiple,$,!1):y!==!!l.multiple&&(l.defaultValue!=null?nl(r,!!l.multiple,l.defaultValue,!0):nl(r,!!l.multiple,l.multiple?[]:"",!1))}r[gi]=l}catch(I){Lt(e,e.return,I)}}break;case 6:if(Xn(t,e),ao(e),o&4){if(e.stateNode===null)throw Error(j(162));r=e.stateNode,l=e.memoizedProps;try{r.nodeValue=l}catch(I){Lt(e,e.return,I)}}break;case 3:if(Xn(t,e),ao(e),o&4&&n!==null&&n.memoizedState.isDehydrated)try{_i(t.containerInfo)}catch(I){Lt(e,e.return,I)}break;case 4:Xn(t,e),ao(e);break;case 13:Xn(t,e),ao(e),r=e.child,r.flags&8192&&(l=r.memoizedState!==null,r.stateNode.isHidden=l,!l||r.alternate!==null&&r.alternate.memoizedState!==null||(lu=Rt())),o&4&&Bf(e);break;case 22:if(p=n!==null&&n.memoizedState!==null,e.mode&1?(Zt=(m=Zt)||p,Xn(t,e),Zt=m):Xn(t,e),ao(e),o&8192){if(m=e.memoizedState!==null,(e.stateNode.isHidden=m)&&!p&&(e.mode&1)!==0)for(ne=e,p=e.child;p!==null;){for(b=ne=p;ne!==null;){switch(y=ne,$=y.child,y.tag){case 0:case 11:case 14:case 15:ri(4,y,y.return);break;case 1:el(y,y.return);var C=y.stateNode;if(typeof C.componentWillUnmount=="function"){o=y,n=y.return;try{t=o,C.props=t.memoizedProps,C.state=t.memoizedState,C.componentWillUnmount()}catch(I){Lt(o,n,I)}}break;case 5:el(y,y.return);break;case 22:if(y.memoizedState!==null){Of(b);continue}}$!==null?($.return=y,ne=$):Of(b)}p=p.sibling}e:for(p=null,b=e;;){if(b.tag===5){if(p===null){p=b;try{r=b.stateNode,m?(l=r.style,typeof l.setProperty=="function"?l.setProperty("display","none","important"):l.display="none"):(s=b.stateNode,a=b.memoizedProps.style,i=a!=null&&a.hasOwnProperty("display")?a.display:null,s.style.display=e0("display",i))}catch(I){Lt(e,e.return,I)}}}else if(b.tag===6){if(p===null)try{b.stateNode.nodeValue=m?"":b.memoizedProps}catch(I){Lt(e,e.return,I)}}else if((b.tag!==22&&b.tag!==23||b.memoizedState===null||b===e)&&b.child!==null){b.child.return=b,b=b.child;continue}if(b===e)break e;for(;b.sibling===null;){if(b.return===null||b.return===e)break e;p===b&&(p=null),b=b.return}p===b&&(p=null),b.sibling.return=b.return,b=b.sibling}}break;case 19:Xn(t,e),ao(e),o&4&&Bf(e);break;case 21:break;default:Xn(t,e),ao(e)}}function ao(e){var t=e.flags;if(t&2){try{e:{for(var n=e.return;n!==null;){if(Mh(n)){var o=n;break e}n=n.return}throw Error(j(160))}switch(o.tag){case 5:var r=o.stateNode;o.flags&32&&(ai(r,""),o.flags&=-33);var l=Df(e);xd(e,l,r);break;case 3:case 4:var i=o.stateNode.containerInfo,s=Df(e);yd(e,s,i);break;default:throw Error(j(161))}}catch(a){Lt(e,e.return,a)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function kg(e,t,n){ne=e,Ih(e,t,n)}function Ih(e,t,n){for(var o=(e.mode&1)!==0;ne!==null;){var r=ne,l=r.child;if(r.tag===22&&o){var i=r.memoizedState!==null||vs;if(!i){var s=r.alternate,a=s!==null&&s.memoizedState!==null||Zt;s=vs;var m=Zt;if(vs=i,(Zt=a)&&!m)for(ne=r;ne!==null;)i=ne,a=i.child,i.tag===22&&i.memoizedState!==null?Af(r):a!==null?(a.return=i,ne=a):Af(r);for(;l!==null;)ne=l,Ih(l,t,n),l=l.sibling;ne=r,vs=s,Zt=m}zf(e,t,n)}else(r.subtreeFlags&8772)!==0&&l!==null?(l.return=r,ne=l):zf(e,t,n)}}function zf(e){for(;ne!==null;){var t=ne;if((t.flags&8772)!==0){var n=t.alternate;try{if((t.flags&8772)!==0)switch(t.tag){case 0:case 11:case 15:Zt||da(5,t);break;case 1:var o=t.stateNode;if(t.flags&4&&!Zt)if(n===null)o.componentDidMount();else{var r=t.elementType===t.type?n.memoizedProps:Qn(t.type,n.memoizedProps);o.componentDidUpdate(r,n.memoizedState,o.__reactInternalSnapshotBeforeUpdate)}var l=t.updateQueue;l!==null&&wf(t,l,o);break;case 3:var i=t.updateQueue;if(i!==null){if(n=null,t.child!==null)switch(t.child.tag){case 5:n=t.child.stateNode;break;case 1:n=t.child.stateNode}wf(t,i,n)}break;case 5:var s=t.stateNode;if(n===null&&t.flags&4){n=s;var a=t.memoizedProps;switch(t.type){case"button":case"input":case"select":case"textarea":a.autoFocus&&n.focus();break;case"img":a.src&&(n.src=a.src)}}break;case 6:break;case 4:break;case 12:break;case 13:if(t.memoizedState===null){var m=t.alternate;if(m!==null){var p=m.memoizedState;if(p!==null){var b=p.dehydrated;b!==null&&_i(b)}}}break;case 19:case 17:case 21:case 22:case 23:case 25:break;default:throw Error(j(163))}Zt||t.flags&512&&gd(t)}catch(y){Lt(t,t.return,y)}}if(t===e){ne=null;break}if(n=t.sibling,n!==null){n.return=t.return,ne=n;break}ne=t.return}}function Of(e){for(;ne!==null;){var t=ne;if(t===e){ne=null;break}var n=t.sibling;if(n!==null){n.return=t.return,ne=n;break}ne=t.return}}function Af(e){for(;ne!==null;){var t=ne;try{switch(t.tag){case 0:case 11:case 15:var n=t.return;try{da(4,t)}catch(a){Lt(t,n,a)}break;case 1:var o=t.stateNode;if(typeof o.componentDidMount=="function"){var r=t.return;try{o.componentDidMount()}catch(a){Lt(t,r,a)}}var l=t.return;try{gd(t)}catch(a){Lt(t,l,a)}break;case 5:var i=t.return;try{gd(t)}catch(a){Lt(t,i,a)}}}catch(a){Lt(t,t.return,a)}if(t===e){ne=null;break}var s=t.sibling;if(s!==null){s.return=t.return,ne=s;break}ne=t.return}}var Cg=Math.ceil,qs=No.ReactCurrentDispatcher,ou=No.ReactCurrentOwner,Dn=No.ReactCurrentBatchConfig,Qe=0,Ht=null,Bt=null,Xt=0,yn=0,tl=tr(0),Wt=0,ki=null,kr=0,ua=0,ru=0,li=null,_n=null,lu=0,hl=1/0,wo=null,Zs=!1,vd=null,Ko=null,ws=!1,Ho=null,Js=0,ii=0,wd=null,Is=-1,Ns=0;function on(){return(Qe&6)!==0?Rt():Is!==-1?Is:Is=Rt()}function Go(e){return(e.mode&1)===0?1:(Qe&2)!==0&&Xt!==0?Xt&-Xt:sg.transition!==null?(Ns===0&&(Ns=f0()),Ns):(e=rt,e!==0||(e=window.event,e=e===void 0?16:v0(e.type)),e)}function qn(e,t,n,o){if(50<ii)throw ii=0,wd=null,Error(j(185));Ci(e,n,o),((Qe&2)===0||e!==Ht)&&(e===Ht&&((Qe&2)===0&&(ua|=n),Wt===4&&Fo(e,Xt)),mn(e,o),n===1&&Qe===0&&(t.mode&1)===0&&(hl=Rt()+500,sa&&nr()))}function mn(e,t){var n=e.callbackNode;c1(e,t);var o=Bs(e,e===Ht?Xt:0);if(o===0)n!==null&&X_(n),e.callbackNode=null,e.callbackPriority=0;else if(t=o&-o,e.callbackPriority!==t){if(n!=null&&X_(n),t===1)e.tag===0?ig(Wf.bind(null,e)):A0(Wf.bind(null,e)),ng(function(){(Qe&6)===0&&nr()}),n=null;else{switch(h0(o)){case 1:n=$d;break;case 4:n=u0;break;case 16:n=Ds;break;case 536870912:n=_0;break;default:n=Ds}n=zh(n,Nh.bind(null,e))}e.callbackPriority=t,e.callbackNode=n}}function Nh(e,t){if(Is=-1,Ns=0,(Qe&6)!==0)throw Error(j(327));var n=e.callbackNode;if(sl()&&e.callbackNode!==n)return null;var o=Bs(e,e===Ht?Xt:0);if(o===0)return null;if((o&30)!==0||(o&e.expiredLanes)!==0||t)t=ea(e,o);else{t=o;var r=Qe;Qe|=2;var l=Rh();(Ht!==e||Xt!==t)&&(wo=null,hl=Rt()+500,yr(e,t));do try{Eg();break}catch(s){$h(e,s)}while(!0);Ud(),qs.current=l,Qe=r,Bt!==null?t=0:(Ht=null,Xt=0,t=Wt)}if(t!==0){if(t===2&&(r=Vc(e),r!==0&&(o=r,t=bd(e,r))),t===1)throw n=ki,yr(e,0),Fo(e,o),mn(e,Rt()),n;if(t===6)Fo(e,o);else{if(r=e.current.alternate,(o&30)===0&&!Sg(r)&&(t=ea(e,o),t===2&&(l=Vc(e),l!==0&&(o=l,t=bd(e,l))),t===1))throw n=ki,yr(e,0),Fo(e,o),mn(e,Rt()),n;switch(e.finishedWork=r,e.finishedLanes=o,t){case 0:case 1:throw Error(j(345));case 2:hr(e,_n,wo);break;case 3:if(Fo(e,o),(o&130023424)===o&&(t=lu+500-Rt(),10<t)){if(Bs(e,0)!==0)break;if(r=e.suspendedLanes,(r&o)!==o){on(),e.pingedLanes|=e.suspendedLanes&r;break}e.timeoutHandle=nd(hr.bind(null,e,_n,wo),t);break}hr(e,_n,wo);break;case 4:if(Fo(e,o),(o&4194240)===o)break;for(t=e.eventTimes,r=-1;0<o;){var i=31-Gn(o);l=1<<i,i=t[i],i>r&&(r=i),o&=~l}if(o=r,o=Rt()-o,o=(120>o?120:480>o?480:1080>o?1080:1920>o?1920:3e3>o?3e3:4320>o?4320:1960*Cg(o/1960))-o,10<o){e.timeoutHandle=nd(hr.bind(null,e,_n,wo),o);break}hr(e,_n,wo);break;case 5:hr(e,_n,wo);break;default:throw Error(j(329))}}}return mn(e,Rt()),e.callbackNode===n?Nh.bind(null,e):null}function bd(e,t){var n=li;return e.current.memoizedState.isDehydrated&&(yr(e,t).flags|=256),e=ea(e,t),e!==2&&(t=_n,_n=n,t!==null&&kd(t)),e}function kd(e){_n===null?_n=e:_n.push.apply(_n,e)}function Sg(e){for(var t=e;;){if(t.flags&16384){var n=t.updateQueue;if(n!==null&&(n=n.stores,n!==null))for(var o=0;o<n.length;o++){var r=n[o],l=r.getSnapshot;r=r.value;try{if(!Zn(l(),r))return!1}catch{return!1}}}if(n=t.child,t.subtreeFlags&16384&&n!==null)n.return=t,t=n;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Fo(e,t){for(t&=~ru,t&=~ua,e.suspendedLanes|=t,e.pingedLanes&=~t,e=e.expirationTimes;0<t;){var n=31-Gn(t),o=1<<n;e[n]=-1,t&=~o}}function Wf(e){if((Qe&6)!==0)throw Error(j(327));sl();var t=Bs(e,0);if((t&1)===0)return mn(e,Rt()),null;var n=ea(e,t);if(e.tag!==0&&n===2){var o=Vc(e);o!==0&&(t=o,n=bd(e,o))}if(n===1)throw n=ki,yr(e,0),Fo(e,t),mn(e,Rt()),n;if(n===6)throw Error(j(345));return e.finishedWork=e.current.alternate,e.finishedLanes=t,hr(e,_n,wo),mn(e,Rt()),null}function iu(e,t){var n=Qe;Qe|=1;try{return e(t)}finally{Qe=n,Qe===0&&(hl=Rt()+500,sa&&nr())}}function Cr(e){Ho!==null&&Ho.tag===0&&(Qe&6)===0&&sl();var t=Qe;Qe|=1;var n=Dn.transition,o=rt;try{if(Dn.transition=null,rt=1,e)return e()}finally{rt=o,Dn.transition=n,Qe=t,(Qe&6)===0&&nr()}}function su(){yn=tl.current,mt(tl)}function yr(e,t){e.finishedWork=null,e.finishedLanes=0;var n=e.timeoutHandle;if(n!==-1&&(e.timeoutHandle=-1,tg(n)),Bt!==null)for(n=Bt.return;n!==null;){var o=n;switch(Fd(o),o.tag){case 1:o=o.type.childContextTypes,o!=null&&Fs();break;case 3:_l(),mt(hn),mt(Jt),Gd();break;case 5:Kd(o);break;case 4:_l();break;case 13:mt(wt);break;case 19:mt(wt);break;case 10:Yd(o.type._context);break;case 22:case 23:su()}n=n.return}if(Ht=e,Bt=e=qo(e.current,null),Xt=yn=t,Wt=0,ki=null,ru=ua=kr=0,_n=li=null,mr!==null){for(t=0;t<mr.length;t++)if(n=mr[t],o=n.interleaved,o!==null){n.interleaved=null;var r=o.next,l=n.pending;if(l!==null){var i=l.next;l.next=r,o.next=i}n.pending=o}mr=null}return e}function $h(e,t){do{var n=Bt;try{if(Ud(),Ms.current=Gs,Ks){for(var o=bt.memoizedState;o!==null;){var r=o.queue;r!==null&&(r.pending=null),o=o.next}Ks=!1}if(br=0,jt=At=bt=null,oi=!1,vi=0,ou.current=null,n===null||n.return===null){Wt=1,ki=t,Bt=null;break}e:{var l=e,i=n.return,s=n,a=t;if(t=Xt,s.flags|=32768,a!==null&&typeof a=="object"&&typeof a.then=="function"){var m=a,p=s,b=p.tag;if((p.mode&1)===0&&(b===0||b===11||b===15)){var y=p.alternate;y?(p.updateQueue=y.updateQueue,p.memoizedState=y.memoizedState,p.lanes=y.lanes):(p.updateQueue=null,p.memoizedState=null)}var $=Ef(i);if($!==null){$.flags&=-257,Lf($,i,s,l,t),$.mode&1&&Mf(l,m,t),t=$,a=m;var C=t.updateQueue;if(C===null){var I=new Set;I.add(a),t.updateQueue=I}else C.add(a);break e}else{if((t&1)===0){Mf(l,m,t),au();break e}a=Error(j(426))}}else if(gt&&s.mode&1){var E=Ef(i);if(E!==null){(E.flags&65536)===0&&(E.flags|=256),Lf(E,i,s,l,t),jd(fl(a,s));break e}}l=a=fl(a,s),Wt!==4&&(Wt=2),li===null?li=[l]:li.push(l),l=i;do{switch(l.tag){case 3:l.flags|=65536,t&=-t,l.lanes|=t;var f=hh(l,a,t);vf(l,f);break e;case 1:s=a;var g=l.type,w=l.stateNode;if((l.flags&128)===0&&(typeof g.getDerivedStateFromError=="function"||w!==null&&typeof w.componentDidCatch=="function"&&(Ko===null||!Ko.has(w)))){l.flags|=65536,t&=-t,l.lanes|=t;var N=ph(l,s,t);vf(l,N);break e}}l=l.return}while(l!==null)}Ph(n)}catch(H){t=H,Bt===n&&n!==null&&(Bt=n=n.return);continue}break}while(!0)}function Rh(){var e=qs.current;return qs.current=Gs,e===null?Gs:e}function au(){(Wt===0||Wt===3||Wt===2)&&(Wt=4),Ht===null||(kr&268435455)===0&&(ua&268435455)===0||Fo(Ht,Xt)}function ea(e,t){var n=Qe;Qe|=2;var o=Rh();(Ht!==e||Xt!==t)&&(wo=null,yr(e,t));do try{Mg();break}catch(r){$h(e,r)}while(!0);if(Ud(),Qe=n,qs.current=o,Bt!==null)throw Error(j(261));return Ht=null,Xt=0,Wt}function Mg(){for(;Bt!==null;)Th(Bt)}function Eg(){for(;Bt!==null&&!e1();)Th(Bt)}function Th(e){var t=Bh(e.alternate,e,yn);e.memoizedProps=e.pendingProps,t===null?Ph(e):Bt=t,ou.current=null}function Ph(e){var t=e;do{var n=t.alternate;if(e=t.return,(t.flags&32768)===0){if(n=xg(n,t,yn),n!==null){Bt=n;return}}else{if(n=vg(n,t),n!==null){n.flags&=32767,Bt=n;return}if(e!==null)e.flags|=32768,e.subtreeFlags=0,e.deletions=null;else{Wt=6,Bt=null;return}}if(t=t.sibling,t!==null){Bt=t;return}Bt=t=e}while(t!==null);Wt===0&&(Wt=5)}function hr(e,t,n){var o=rt,r=Dn.transition;try{Dn.transition=null,rt=1,Lg(e,t,n,o)}finally{Dn.transition=r,rt=o}return null}function Lg(e,t,n,o){do sl();while(Ho!==null);if((Qe&6)!==0)throw Error(j(327));n=e.finishedWork;var r=e.finishedLanes;if(n===null)return null;if(e.finishedWork=null,e.finishedLanes=0,n===e.current)throw Error(j(177));e.callbackNode=null,e.callbackPriority=0;var l=n.lanes|n.childLanes;if(d1(e,l),e===Ht&&(Bt=Ht=null,Xt=0),(n.subtreeFlags&2064)===0&&(n.flags&2064)===0||ws||(ws=!0,zh(Ds,function(){return sl(),null})),l=(n.flags&15990)!==0,(n.subtreeFlags&15990)!==0||l){l=Dn.transition,Dn.transition=null;var i=rt;rt=1;var s=Qe;Qe|=4,ou.current=null,bg(e,n),Lh(n,e),G1(ed),zs=!!Jc,ed=Jc=null,e.current=n,kg(n,e,r),t1(),Qe=s,rt=i,Dn.transition=l}else e.current=n;if(ws&&(ws=!1,Ho=e,Js=r),l=e.pendingLanes,l===0&&(Ko=null),r1(n.stateNode,o),mn(e,Rt()),t!==null)for(o=e.onRecoverableError,n=0;n<t.length;n++)r=t[n],o(r.value,{componentStack:r.stack,digest:r.digest});if(Zs)throw Zs=!1,e=vd,vd=null,e;return(Js&1)!==0&&e.tag!==0&&sl(),l=e.pendingLanes,(l&1)!==0?e===wd?ii++:(ii=0,wd=e):ii=0,nr(),null}function sl(){if(Ho!==null){var e=h0(Js),t=Dn.transition,n=rt;try{if(Dn.transition=null,rt=16>e?16:e,Ho===null)var o=!1;else{if(e=Ho,Ho=null,Js=0,(Qe&6)!==0)throw Error(j(331));var r=Qe;for(Qe|=4,ne=e.current;ne!==null;){var l=ne,i=l.child;if((ne.flags&16)!==0){var s=l.deletions;if(s!==null){for(var a=0;a<s.length;a++){var m=s[a];for(ne=m;ne!==null;){var p=ne;switch(p.tag){case 0:case 11:case 15:ri(8,p,l)}var b=p.child;if(b!==null)b.return=p,ne=b;else for(;ne!==null;){p=ne;var y=p.sibling,$=p.return;if(Sh(p),p===m){ne=null;break}if(y!==null){y.return=$,ne=y;break}ne=$}}}var C=l.alternate;if(C!==null){var I=C.child;if(I!==null){C.child=null;do{var E=I.sibling;I.sibling=null,I=E}while(I!==null)}}ne=l}}if((l.subtreeFlags&2064)!==0&&i!==null)i.return=l,ne=i;else e:for(;ne!==null;){if(l=ne,(l.flags&2048)!==0)switch(l.tag){case 0:case 11:case 15:ri(9,l,l.return)}var f=l.sibling;if(f!==null){f.return=l.return,ne=f;break e}ne=l.return}}var g=e.current;for(ne=g;ne!==null;){i=ne;var w=i.child;if((i.subtreeFlags&2064)!==0&&w!==null)w.return=i,ne=w;else e:for(i=g;ne!==null;){if(s=ne,(s.flags&2048)!==0)try{switch(s.tag){case 0:case 11:case 15:da(9,s)}}catch(H){Lt(s,s.return,H)}if(s===i){ne=null;break e}var N=s.sibling;if(N!==null){N.return=s.return,ne=N;break e}ne=s.return}}if(Qe=r,nr(),_o&&typeof _o.onPostCommitFiberRoot=="function")try{_o.onPostCommitFiberRoot(na,e)}catch{}o=!0}return o}finally{rt=n,Dn.transition=t}}return!1}function Ff(e,t,n){t=fl(n,t),t=hh(e,t,1),e=Vo(e,t,1),t=on(),e!==null&&(Ci(e,1,t),mn(e,t))}function Lt(e,t,n){if(e.tag===3)Ff(e,e,n);else for(;t!==null;){if(t.tag===3){Ff(t,e,n);break}else if(t.tag===1){var o=t.stateNode;if(typeof t.type.getDerivedStateFromError=="function"||typeof o.componentDidCatch=="function"&&(Ko===null||!Ko.has(o))){e=fl(n,e),e=ph(t,e,1),t=Vo(t,e,1),e=on(),t!==null&&(Ci(t,1,e),mn(t,e));break}}t=t.return}}function Ig(e,t,n){var o=e.pingCache;o!==null&&o.delete(t),t=on(),e.pingedLanes|=e.suspendedLanes&n,Ht===e&&(Xt&n)===n&&(Wt===4||Wt===3&&(Xt&130023424)===Xt&&500>Rt()-lu?yr(e,0):ru|=n),mn(e,t)}function Dh(e,t){t===0&&((e.mode&1)===0?t=1:(t=ss,ss<<=1,(ss&130023424)===0&&(ss=4194304)));var n=on();e=Lo(e,t),e!==null&&(Ci(e,t,n),mn(e,n))}function Ng(e){var t=e.memoizedState,n=0;t!==null&&(n=t.retryLane),Dh(e,n)}function $g(e,t){var n=0;switch(e.tag){case 13:var o=e.stateNode,r=e.memoizedState;r!==null&&(n=r.retryLane);break;case 19:o=e.stateNode;break;default:throw Error(j(314))}o!==null&&o.delete(t),Dh(e,n)}var Bh;Bh=function(e,t,n){if(e!==null)if(e.memoizedProps!==t.pendingProps||hn.current)fn=!0;else{if((e.lanes&n)===0&&(t.flags&128)===0)return fn=!1,yg(e,t,n);fn=(e.flags&131072)!==0}else fn=!1,gt&&(t.flags&1048576)!==0&&W0(t,Us,t.index);switch(t.lanes=0,t.tag){case 2:var o=t.type;Ls(e,t),e=t.pendingProps;var r=cl(t,Jt.current);il(t,n),r=Zd(null,t,o,e,r,n);var l=Jd();return t.flags|=1,typeof r=="object"&&r!==null&&typeof r.render=="function"&&r.$$typeof===void 0?(t.tag=1,t.memoizedState=null,t.updateQueue=null,pn(o)?(l=!0,js(t)):l=!1,t.memoizedState=r.state!==null&&r.state!==void 0?r.state:null,Qd(t),r.updater=ca,t.stateNode=r,r._reactInternals=t,cd(t,o,e,n),t=_d(null,t,o,!0,l,n)):(t.tag=0,gt&&l&&Wd(t),nn(null,t,r,n),t=t.child),t;case 16:o=t.elementType;e:{switch(Ls(e,t),e=t.pendingProps,r=o._init,o=r(o._payload),t.type=o,r=t.tag=Tg(o),e=Qn(o,e),r){case 0:t=ud(null,t,o,e,n);break e;case 1:t=$f(null,t,o,e,n);break e;case 11:t=If(null,t,o,e,n);break e;case 14:t=Nf(null,t,o,Qn(o.type,e),n);break e}throw Error(j(306,o,""))}return t;case 0:return o=t.type,r=t.pendingProps,r=t.elementType===o?r:Qn(o,r),ud(e,t,o,r,n);case 1:return o=t.type,r=t.pendingProps,r=t.elementType===o?r:Qn(o,r),$f(e,t,o,r,n);case 3:e:{if(xh(t),e===null)throw Error(j(387));o=t.pendingProps,l=t.memoizedState,r=l.element,X0(e,t),Qs(t,o,null,n);var i=t.memoizedState;if(o=i.element,l.isDehydrated)if(l={element:o,isDehydrated:!1,cache:i.cache,pendingSuspenseBoundaries:i.pendingSuspenseBoundaries,transitions:i.transitions},t.updateQueue.baseState=l,t.memoizedState=l,t.flags&256){r=fl(Error(j(423)),t),t=Rf(e,t,o,n,r);break e}else if(o!==r){r=fl(Error(j(424)),t),t=Rf(e,t,o,n,r);break e}else for(xn=Qo(t.stateNode.containerInfo.firstChild),vn=t,gt=!0,Kn=null,n=U0(t,null,o,n),t.child=n;n;)n.flags=n.flags&-3|4096,n=n.sibling;else{if(dl(),o===r){t=Io(e,t,n);break e}nn(e,t,o,n)}t=t.child}return t;case 5:return Q0(t),e===null&&id(t),o=t.type,r=t.pendingProps,l=e!==null?e.memoizedProps:null,i=r.children,td(o,r)?i=null:l!==null&&td(o,l)&&(t.flags|=32),yh(e,t),nn(e,t,i,n),t.child;case 6:return e===null&&id(t),null;case 13:return vh(e,t,n);case 4:return Vd(t,t.stateNode.containerInfo),o=t.pendingProps,e===null?t.child=ul(t,null,o,n):nn(e,t,o,n),t.child;case 11:return o=t.type,r=t.pendingProps,r=t.elementType===o?r:Qn(o,r),If(e,t,o,r,n);case 7:return nn(e,t,t.pendingProps,n),t.child;case 8:return nn(e,t,t.pendingProps.children,n),t.child;case 12:return nn(e,t,t.pendingProps.children,n),t.child;case 10:e:{if(o=t.type._context,r=t.pendingProps,l=t.memoizedProps,i=r.value,ht(Ys,o._currentValue),o._currentValue=i,l!==null)if(Zn(l.value,i)){if(l.children===r.children&&!hn.current){t=Io(e,t,n);break e}}else for(l=t.child,l!==null&&(l.return=t);l!==null;){var s=l.dependencies;if(s!==null){i=l.child;for(var a=s.firstContext;a!==null;){if(a.context===o){if(l.tag===1){a=So(-1,n&-n),a.tag=2;var m=l.updateQueue;if(m!==null){m=m.shared;var p=m.pending;p===null?a.next=a:(a.next=p.next,p.next=a),m.pending=a}}l.lanes|=n,a=l.alternate,a!==null&&(a.lanes|=n),sd(l.return,n,t),s.lanes|=n;break}a=a.next}}else if(l.tag===10)i=l.type===t.type?null:l.child;else if(l.tag===18){if(i=l.return,i===null)throw Error(j(341));i.lanes|=n,s=i.alternate,s!==null&&(s.lanes|=n),sd(i,n,t),i=l.sibling}else i=l.child;if(i!==null)i.return=l;else for(i=l;i!==null;){if(i===t){i=null;break}if(l=i.sibling,l!==null){l.return=i.return,i=l;break}i=i.return}l=i}nn(e,t,r.children,n),t=t.child}return t;case 9:return r=t.type,o=t.pendingProps.children,il(t,n),r=Bn(r),o=o(r),t.flags|=1,nn(e,t,o,n),t.child;case 14:return o=t.type,r=Qn(o,t.pendingProps),r=Qn(o.type,r),Nf(e,t,o,r,n);case 15:return mh(e,t,t.type,t.pendingProps,n);case 17:return o=t.type,r=t.pendingProps,r=t.elementType===o?r:Qn(o,r),Ls(e,t),t.tag=1,pn(o)?(e=!0,js(t)):e=!1,il(t,n),fh(t,o,r),cd(t,o,r,n),_d(null,t,o,!0,e,n);case 19:return wh(e,t,n);case 22:return gh(e,t,n)}throw Error(j(156,t.tag))};function zh(e,t){return d0(e,t)}function Rg(e,t,n,o){this.tag=e,this.key=n,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=o,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function Pn(e,t,n,o){return new Rg(e,t,n,o)}function cu(e){return e=e.prototype,!(!e||!e.isReactComponent)}function Tg(e){if(typeof e=="function")return cu(e)?1:0;if(e!=null){if(e=e.$$typeof,e===Ld)return 11;if(e===Id)return 14}return 2}function qo(e,t){var n=e.alternate;return n===null?(n=Pn(e.tag,t,e.key,e.mode),n.elementType=e.elementType,n.type=e.type,n.stateNode=e.stateNode,n.alternate=e,e.alternate=n):(n.pendingProps=t,n.type=e.type,n.flags=0,n.subtreeFlags=0,n.deletions=null),n.flags=e.flags&14680064,n.childLanes=e.childLanes,n.lanes=e.lanes,n.child=e.child,n.memoizedProps=e.memoizedProps,n.memoizedState=e.memoizedState,n.updateQueue=e.updateQueue,t=e.dependencies,n.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},n.sibling=e.sibling,n.index=e.index,n.ref=e.ref,n}function $s(e,t,n,o,r,l){var i=2;if(o=e,typeof e=="function")cu(e)&&(i=1);else if(typeof e=="string")i=5;else e:switch(e){case Yr:return xr(n.children,r,l,t);case Ed:i=8,r|=8;break;case Tc:return e=Pn(12,n,t,r|2),e.elementType=Tc,e.lanes=l,e;case Pc:return e=Pn(13,n,t,r),e.elementType=Pc,e.lanes=l,e;case Dc:return e=Pn(19,n,t,r),e.elementType=Dc,e.lanes=l,e;case Qf:return _a(n,r,l,t);default:if(typeof e=="object"&&e!==null)switch(e.$$typeof){case Yf:i=10;break e;case Xf:i=9;break e;case Ld:i=11;break e;case Id:i=14;break e;case Oo:i=16,o=null;break e}throw Error(j(130,e==null?e:typeof e,""))}return t=Pn(i,n,t,r),t.elementType=e,t.type=o,t.lanes=l,t}function xr(e,t,n,o){return e=Pn(7,e,o,t),e.lanes=n,e}function _a(e,t,n,o){return e=Pn(22,e,o,t),e.elementType=Qf,e.lanes=n,e.stateNode={isHidden:!1},e}function Nc(e,t,n){return e=Pn(6,e,null,t),e.lanes=n,e}function $c(e,t,n){return t=Pn(4,e.children!==null?e.children:[],e.key,t),t.lanes=n,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}function Pg(e,t,n,o,r){this.tag=t,this.containerInfo=e,this.finishedWork=this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.pendingContext=this.context=null,this.callbackPriority=0,this.eventTimes=hc(0),this.expirationTimes=hc(-1),this.entangledLanes=this.finishedLanes=this.mutableReadLanes=this.expiredLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=hc(0),this.identifierPrefix=o,this.onRecoverableError=r,this.mutableSourceEagerHydrationData=null}function du(e,t,n,o,r,l,i,s,a){return e=new Pg(e,t,n,s,a),t===1?(t=1,l===!0&&(t|=8)):t=0,l=Pn(3,null,null,t),e.current=l,l.stateNode=e,l.memoizedState={element:o,isDehydrated:n,cache:null,transitions:null,pendingSuspenseBoundaries:null},Qd(l),e}function Dg(e,t,n){var o=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:Ur,key:o==null?null:""+o,children:e,containerInfo:t,implementation:n}}function Oh(e){if(!e)return Jo;e=e._reactInternals;e:{if(Mr(e)!==e||e.tag!==1)throw Error(j(170));var t=e;do{switch(t.tag){case 3:t=t.stateNode.context;break e;case 1:if(pn(t.type)){t=t.stateNode.__reactInternalMemoizedMergedChildContext;break e}}t=t.return}while(t!==null);throw Error(j(171))}if(e.tag===1){var n=e.type;if(pn(n))return O0(e,n,t)}return t}function Ah(e,t,n,o,r,l,i,s,a){return e=du(n,o,!0,e,r,l,i,s,a),e.context=Oh(null),n=e.current,o=on(),r=Go(n),l=So(o,r),l.callback=t??null,Vo(n,l,r),e.current.lanes=r,Ci(e,r,o),mn(e,o),e}function fa(e,t,n,o){var r=t.current,l=on(),i=Go(r);return n=Oh(n),t.context===null?t.context=n:t.pendingContext=n,t=So(l,i),t.payload={element:e},o=o===void 0?null:o,o!==null&&(t.callback=o),e=Vo(r,t,i),e!==null&&(qn(e,r,i,l),Ss(e,r,i)),i}function ta(e){return e=e.current,e.child?(e.child.tag===5,e.child.stateNode):null}function jf(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var n=e.retryLane;e.retryLane=n!==0&&n<t?n:t}}function uu(e,t){jf(e,t),(e=e.alternate)&&jf(e,t)}function Bg(){return null}var Wh=typeof reportError=="function"?reportError:function(e){console.error(e)};function _u(e){this._internalRoot=e}ha.prototype.render=_u.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(j(409));fa(e,t,null,null)};ha.prototype.unmount=_u.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;Cr(function(){fa(null,e,null,null)}),t[Eo]=null}};function ha(e){this._internalRoot=e}ha.prototype.unstable_scheduleHydration=function(e){if(e){var t=g0();e={blockedOn:null,target:e,priority:t};for(var n=0;n<Wo.length&&t!==0&&t<Wo[n].priority;n++);Wo.splice(n,0,e),n===0&&x0(e)}};function fu(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}function pa(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11&&(e.nodeType!==8||e.nodeValue!==" react-mount-point-unstable "))}function Hf(){}function zg(e,t,n,o,r){if(r){if(typeof o=="function"){var l=o;o=function(){var m=ta(i);l.call(m)}}var i=Ah(t,o,e,0,null,!1,!1,"",Hf);return e._reactRootContainer=i,e[Eo]=i.current,pi(e.nodeType===8?e.parentNode:e),Cr(),i}for(;r=e.lastChild;)e.removeChild(r);if(typeof o=="function"){var s=o;o=function(){var m=ta(a);s.call(m)}}var a=du(e,0,!1,null,null,!1,!1,"",Hf);return e._reactRootContainer=a,e[Eo]=a.current,pi(e.nodeType===8?e.parentNode:e),Cr(function(){fa(t,a,n,o)}),a}function ma(e,t,n,o,r){var l=n._reactRootContainer;if(l){var i=l;if(typeof r=="function"){var s=r;r=function(){var a=ta(i);s.call(a)}}fa(t,i,e,r)}else i=zg(n,t,e,r,o);return ta(i)}p0=function(e){switch(e.tag){case 3:var t=e.stateNode;if(t.current.memoizedState.isDehydrated){var n=Gl(t.pendingLanes);n!==0&&(Rd(t,n|1),mn(t,Rt()),(Qe&6)===0&&(hl=Rt()+500,nr()))}break;case 13:Cr(function(){var o=Lo(e,1);if(o!==null){var r=on();qn(o,e,1,r)}}),uu(e,1)}};Td=function(e){if(e.tag===13){var t=Lo(e,134217728);if(t!==null){var n=on();qn(t,e,134217728,n)}uu(e,134217728)}};m0=function(e){if(e.tag===13){var t=Go(e),n=Lo(e,t);if(n!==null){var o=on();qn(n,e,t,o)}uu(e,t)}};g0=function(){return rt};y0=function(e,t){var n=rt;try{return rt=e,t()}finally{rt=n}};Yc=function(e,t,n){switch(t){case"input":if(Oc(e,n),t=n.name,n.type==="radio"&&t!=null){for(n=e;n.parentNode;)n=n.parentNode;for(n=n.querySelectorAll("input[name="+JSON.stringify(""+t)+'][type="radio"]'),t=0;t<n.length;t++){var o=n[t];if(o!==e&&o.form===e.form){var r=ia(o);if(!r)throw Error(j(90));Kf(o),Oc(o,r)}}}break;case"textarea":qf(e,n);break;case"select":t=n.value,t!=null&&nl(e,!!n.multiple,t,!1)}};r0=iu;l0=Cr;var Og={usingClientEntryPoint:!1,Events:[Mi,Kr,ia,n0,o0,iu]},Xl={findFiberByHostInstance:pr,bundleType:0,version:"18.3.1",rendererPackageName:"react-dom"},Ag={bundleType:Xl.bundleType,version:Xl.version,rendererPackageName:Xl.rendererPackageName,rendererConfig:Xl.rendererConfig,overrideHookState:null,overrideHookStateDeletePath:null,overrideHookStateRenamePath:null,overrideProps:null,overridePropsDeletePath:null,overridePropsRenamePath:null,setErrorHandler:null,setSuspenseHandler:null,scheduleUpdate:null,currentDispatcherRef:No.ReactCurrentDispatcher,findHostInstanceByFiber:function(e){return e=a0(e),e===null?null:e.stateNode},findFiberByHostInstance:Xl.findFiberByHostInstance||Bg,findHostInstancesForRefresh:null,scheduleRefresh:null,scheduleRoot:null,setRefreshHandler:null,getCurrentFiber:null,reconcilerVersion:"18.3.1-next-f1338f8080-20240426"};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<"u"&&(Ql=__REACT_DEVTOOLS_GLOBAL_HOOK__,!Ql.isDisabled&&Ql.supportsFiber))try{na=Ql.inject(Ag),_o=Ql}catch{}var Ql;kn.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED=Og;kn.createPortal=function(e,t){var n=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!fu(t))throw Error(j(200));return Dg(e,t,null,n)};kn.createRoot=function(e,t){if(!fu(e))throw Error(j(299));var n=!1,o="",r=Wh;return t!=null&&(t.unstable_strictMode===!0&&(n=!0),t.identifierPrefix!==void 0&&(o=t.identifierPrefix),t.onRecoverableError!==void 0&&(r=t.onRecoverableError)),t=du(e,1,!1,null,null,n,!1,o,r),e[Eo]=t.current,pi(e.nodeType===8?e.parentNode:e),new _u(t)};kn.findDOMNode=function(e){if(e==null)return null;if(e.nodeType===1)return e;var t=e._reactInternals;if(t===void 0)throw typeof e.render=="function"?Error(j(188)):(e=Object.keys(e).join(","),Error(j(268,e)));return e=a0(t),e=e===null?null:e.stateNode,e};kn.flushSync=function(e){return Cr(e)};kn.hydrate=function(e,t,n){if(!pa(t))throw Error(j(200));return ma(null,e,t,!0,n)};kn.hydrateRoot=function(e,t,n){if(!fu(e))throw Error(j(405));var o=n!=null&&n.hydratedSources||null,r=!1,l="",i=Wh;if(n!=null&&(n.unstable_strictMode===!0&&(r=!0),n.identifierPrefix!==void 0&&(l=n.identifierPrefix),n.onRecoverableError!==void 0&&(i=n.onRecoverableError)),t=Ah(t,null,e,1,n??null,r,!1,l,i),e[Eo]=t.current,pi(e),o)for(e=0;e<o.length;e++)n=o[e],r=n._getVersion,r=r(n._source),t.mutableSourceEagerHydrationData==null?t.mutableSourceEagerHydrationData=[n,r]:t.mutableSourceEagerHydrationData.push(n,r);return new ha(t)};kn.render=function(e,t,n){if(!pa(t))throw Error(j(200));return ma(null,e,t,!1,n)};kn.unmountComponentAtNode=function(e){if(!pa(e))throw Error(j(40));return e._reactRootContainer?(Cr(function(){ma(null,null,e,!1,function(){e._reactRootContainer=null,e[Eo]=null})}),!0):!1};kn.unstable_batchedUpdates=iu;kn.unstable_renderSubtreeIntoContainer=function(e,t,n,o){if(!pa(n))throw Error(j(200));if(e==null||e._reactInternals===void 0)throw Error(j(38));return ma(e,t,n,!1,o)};kn.version="18.3.1-next-f1338f8080-20240426"});var ga=vo((Cx,Hh)=>{"use strict";function jh(){if(!(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__>"u"||typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE!="function"))try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(jh)}catch(e){console.error(e)}}jh(),Hh.exports=Fh()});var Yh=vo(ya=>{"use strict";var Wg=Nn(),Fg=Symbol.for("react.element"),jg=Symbol.for("react.fragment"),Hg=Object.prototype.hasOwnProperty,Ug=Wg.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED.ReactCurrentOwner,Yg={key:!0,ref:!0,__self:!0,__source:!0};function Uh(e,t,n){var o,r={},l=null,i=null;n!==void 0&&(l=""+n),t.key!==void 0&&(l=""+t.key),t.ref!==void 0&&(i=t.ref);for(o in t)Hg.call(t,o)&&!Yg.hasOwnProperty(o)&&(r[o]=t[o]);if(e&&e.defaultProps)for(o in t=e.defaultProps,t)r[o]===void 0&&(r[o]=t[o]);return{$$typeof:Fg,type:e,key:l,ref:i,props:r,_owner:Ug.current}}ya.Fragment=jg;ya.jsx=Uh;ya.jsxs=Uh});var ln=vo((Mx,Xh)=>{"use strict";Xh.exports=Yh()});var Ap=vo(Ou=>{"use strict";var Op=ga();Ou.createRoot=Op.createRoot,Ou.hydrateRoot=Op.hydrateRoot;var Lx});var M=_t(Nn(),1),yp=_t(ga(),1),Ct=_t(Nn(),1),Q=_t(ln(),1),yt=_t(ln(),1),po=_t(Nn(),1),wp=_t(ga(),1),$r=_t(ln(),1),Eu=_t(ln(),1),Ve=_t(Nn(),1),d=_t(ln(),1),dt=_t(ln(),1),St=_t(Nn(),1),c=_t(ln(),1),ke=_t(Nn(),1),He=_t(ln(),1),Dp=_t(Nn(),1),Cn=_t(ln(),1),Bi=_t(ln(),1),Bp=_t(Nn(),1),bl=_t(ln(),1),kl=_t(ln(),1),q=_t(ln(),1),W=_t(ln(),1),Xg=`.styles-module__popup___IhzrD svg[fill=none] {
  fill: none !important;
}
.styles-module__popup___IhzrD svg[fill=none] :not([fill]) {
  fill: none !important;
}

@keyframes styles-module__popupEnter___AuQDN {
  from {
    opacity: 0;
    transform: translateX(-50%) scale(0.95) translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) scale(1) translateY(0);
  }
}
@keyframes styles-module__popupExit___JJKQX {
  from {
    opacity: 1;
    transform: translateX(-50%) scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: translateX(-50%) scale(0.95) translateY(4px);
  }
}
@keyframes styles-module__shake___jdbWe {
  0%, 100% {
    transform: translateX(-50%) scale(1) translateY(0) translateX(0);
  }
  20% {
    transform: translateX(-50%) scale(1) translateY(0) translateX(-3px);
  }
  40% {
    transform: translateX(-50%) scale(1) translateY(0) translateX(3px);
  }
  60% {
    transform: translateX(-50%) scale(1) translateY(0) translateX(-2px);
  }
  80% {
    transform: translateX(-50%) scale(1) translateY(0) translateX(2px);
  }
}
.styles-module__popup___IhzrD {
  position: fixed;
  transform: translateX(-50%);
  width: 280px;
  padding: 0.75rem 1rem 14px;
  background: #1a1a1a;
  border-radius: 16px;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);
  z-index: 100001;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  will-change: transform, opacity;
  opacity: 0;
}
.styles-module__popup___IhzrD.styles-module__enter___L7U7N {
  animation: styles-module__popupEnter___AuQDN 0.2s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}
.styles-module__popup___IhzrD.styles-module__entered___COX-w {
  opacity: 1;
  transform: translateX(-50%) scale(1) translateY(0);
}
.styles-module__popup___IhzrD.styles-module__exit___5eGjE {
  animation: styles-module__popupExit___JJKQX 0.15s ease-in forwards;
}
.styles-module__popup___IhzrD.styles-module__entered___COX-w.styles-module__shake___jdbWe {
  animation: styles-module__shake___jdbWe 0.25s ease-out;
}

.styles-module__header___wWsSi {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5625rem;
}

.styles-module__element___fTV2z {
  font-size: 0.75rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.styles-module__headerToggle___WpW0b {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  background: none;
  border: none;
  padding: 0;
  cursor: pointer;
  flex: 1;
  min-width: 0;
  text-align: left;
}
.styles-module__headerToggle___WpW0b .styles-module__element___fTV2z {
  flex: 1;
}

.styles-module__chevron___ZZJlR {
  color: rgba(255, 255, 255, 0.5);
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  flex-shrink: 0;
}
.styles-module__chevron___ZZJlR.styles-module__expanded___2Hxgv {
  transform: rotate(90deg);
}

.styles-module__stylesWrapper___pnHgy {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.3s cubic-bezier(0.16, 1, 0.3, 1);
}
.styles-module__stylesWrapper___pnHgy.styles-module__expanded___2Hxgv {
  grid-template-rows: 1fr;
}

.styles-module__stylesInner___YYZe2 {
  overflow: hidden;
}

.styles-module__stylesBlock___VfQKn {
  background: rgba(255, 255, 255, 0.05);
  border-radius: 0.375rem;
  padding: 0.5rem 0.625rem;
  margin-bottom: 0.5rem;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 0.6875rem;
  line-height: 1.5;
}

.styles-module__styleLine___1YQiD {
  color: rgba(255, 255, 255, 0.85);
  word-break: break-word;
}

.styles-module__styleProperty___84L1i {
  color: #c792ea;
}

.styles-module__styleValue___q51-h {
  color: rgba(255, 255, 255, 0.85);
}

.styles-module__timestamp___Dtpsv {
  font-size: 0.625rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.35);
  font-variant-numeric: tabular-nums;
  margin-left: 0.5rem;
  flex-shrink: 0;
}

.styles-module__quote___mcMmQ {
  font-size: 12px;
  font-style: italic;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 0.5rem;
  padding: 0.4rem 0.5rem;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 0.25rem;
  line-height: 1.45;
}

.styles-module__textarea___jrSae {
  box-sizing: border-box;
  width: 100%;
  padding: 0.5rem 0.625rem;
  font-size: 0.8125rem;
  font-family: inherit;
  background: rgba(255, 255, 255, 0.05);
  color: #fff;
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  resize: none;
  outline: none;
  transition: border-color 0.15s ease;
}
.styles-module__textarea___jrSae:focus {
  border-color: var(--agentation-color-blue);
}
.styles-module__textarea___jrSae.styles-module__green___99l3h:focus {
  border-color: var(--agentation-color-green);
}
.styles-module__textarea___jrSae::placeholder {
  color: rgba(255, 255, 255, 0.35);
}
.styles-module__textarea___jrSae::-webkit-scrollbar {
  width: 6px;
}
.styles-module__textarea___jrSae::-webkit-scrollbar-track {
  background: transparent;
}
.styles-module__textarea___jrSae::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.styles-module__actions___D6x3f {
  display: flex;
  justify-content: flex-end;
  gap: 0.375rem;
  margin-top: 0.5rem;
}

.styles-module__cancel___hRjnL,
.styles-module__submit___K-mIR {
  padding: 0.4rem 0.875rem;
  font-size: 0.75rem;
  font-weight: 500;
  border-radius: 1rem;
  border: none;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, opacity 0.15s ease;
}

.styles-module__cancel___hRjnL {
  background: transparent;
  color: rgba(255, 255, 255, 0.5);
}
.styles-module__cancel___hRjnL:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}

.styles-module__submit___K-mIR {
  color: white;
}
.styles-module__submit___K-mIR:hover:not(:disabled) {
  filter: brightness(0.9);
}
.styles-module__submit___K-mIR:disabled {
  cursor: not-allowed;
}

.styles-module__deleteWrapper___oSjdo {
  margin-right: auto;
}

.styles-module__deleteButton___4VuAE {
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease;
}
.styles-module__deleteButton___4VuAE:hover {
  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);
  color: var(--agentation-color-red);
}
.styles-module__deleteButton___4VuAE:active {
  transform: scale(0.92);
}

.styles-module__light___6AaSQ.styles-module__popup___IhzrD {
  background: #fff;
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);
}
.styles-module__light___6AaSQ .styles-module__element___fTV2z {
  color: rgba(0, 0, 0, 0.6);
}
.styles-module__light___6AaSQ .styles-module__timestamp___Dtpsv {
  color: rgba(0, 0, 0, 0.4);
}
.styles-module__light___6AaSQ .styles-module__chevron___ZZJlR {
  color: rgba(0, 0, 0, 0.4);
}
.styles-module__light___6AaSQ .styles-module__stylesBlock___VfQKn {
  background: rgba(0, 0, 0, 0.03);
}
.styles-module__light___6AaSQ .styles-module__styleLine___1YQiD {
  color: rgba(0, 0, 0, 0.75);
}
.styles-module__light___6AaSQ .styles-module__styleProperty___84L1i {
  color: #7c3aed;
}
.styles-module__light___6AaSQ .styles-module__styleValue___q51-h {
  color: rgba(0, 0, 0, 0.75);
}
.styles-module__light___6AaSQ .styles-module__quote___mcMmQ {
  color: rgba(0, 0, 0, 0.55);
  background: rgba(0, 0, 0, 0.04);
}
.styles-module__light___6AaSQ .styles-module__textarea___jrSae {
  background: rgba(0, 0, 0, 0.03);
  color: #1a1a1a;
  border-color: rgba(0, 0, 0, 0.12);
}
.styles-module__light___6AaSQ .styles-module__textarea___jrSae::placeholder {
  color: rgba(0, 0, 0, 0.4);
}
.styles-module__light___6AaSQ .styles-module__textarea___jrSae::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.15);
}
.styles-module__light___6AaSQ .styles-module__cancel___hRjnL {
  color: rgba(0, 0, 0, 0.5);
}
.styles-module__light___6AaSQ .styles-module__cancel___hRjnL:hover {
  background: rgba(0, 0, 0, 0.06);
  color: rgba(0, 0, 0, 0.75);
}
.styles-module__light___6AaSQ .styles-module__deleteButton___4VuAE {
  color: rgba(0, 0, 0, 0.4);
}
.styles-module__light___6AaSQ .styles-module__deleteButton___4VuAE:hover {
  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);
  color: var(--agentation-color-red);
}`,Qg={popup:"styles-module__popup___IhzrD",enter:"styles-module__enter___L7U7N",popupEnter:"styles-module__popupEnter___AuQDN",entered:"styles-module__entered___COX-w",exit:"styles-module__exit___5eGjE",popupExit:"styles-module__popupExit___JJKQX",shake:"styles-module__shake___jdbWe",header:"styles-module__header___wWsSi",element:"styles-module__element___fTV2z",headerToggle:"styles-module__headerToggle___WpW0b",chevron:"styles-module__chevron___ZZJlR",expanded:"styles-module__expanded___2Hxgv",stylesWrapper:"styles-module__stylesWrapper___pnHgy",stylesInner:"styles-module__stylesInner___YYZe2",stylesBlock:"styles-module__stylesBlock___VfQKn",styleLine:"styles-module__styleLine___1YQiD",styleProperty:"styles-module__styleProperty___84L1i",styleValue:"styles-module__styleValue___q51-h",timestamp:"styles-module__timestamp___Dtpsv",quote:"styles-module__quote___mcMmQ",textarea:"styles-module__textarea___jrSae",green:"styles-module__green___99l3h",actions:"styles-module__actions___D6x3f",cancel:"styles-module__cancel___hRjnL",submit:"styles-module__submit___K-mIR",deleteWrapper:"styles-module__deleteWrapper___oSjdo",deleteButton:"styles-module__deleteButton___4VuAE",light:"styles-module__light___6AaSQ"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-annotation-popup-css-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-annotation-popup-css-styles",document.head.appendChild(e)),e.textContent=Xg}var ct=Qg,Vg=`.icon-transitions-module__iconState___uqK9J {
  transition: opacity 0.2s ease, transform 0.2s ease;
  transform-origin: center;
}

.icon-transitions-module__iconStateFast___HxlMm {
  transition: opacity 0.15s ease, transform 0.15s ease;
  transform-origin: center;
}

.icon-transitions-module__iconFade___nPwXg {
  transition: opacity 0.2s ease;
}

.icon-transitions-module__iconFadeFast___Ofb2t {
  transition: opacity 0.15s ease;
}

.icon-transitions-module__visible___PlHsU {
  opacity: 1 !important;
}

.icon-transitions-module__visibleScaled___8Qog- {
  opacity: 1 !important;
  transform: scale(1);
}

.icon-transitions-module__hidden___ETykt {
  opacity: 0 !important;
}

.icon-transitions-module__hiddenScaled___JXn-m {
  opacity: 0 !important;
  transform: scale(0.8);
}

.icon-transitions-module__sending___uaLN- {
  opacity: 0.5 !important;
  transform: scale(0.8);
}`,Kg={iconState:"icon-transitions-module__iconState___uqK9J",iconStateFast:"icon-transitions-module__iconStateFast___HxlMm",iconFade:"icon-transitions-module__iconFade___nPwXg",iconFadeFast:"icon-transitions-module__iconFadeFast___Ofb2t",visible:"icon-transitions-module__visible___PlHsU",visibleScaled:"icon-transitions-module__visibleScaled___8Qog-",hidden:"icon-transitions-module__hidden___ETykt",hiddenScaled:"icon-transitions-module__hiddenScaled___JXn-m",sending:"icon-transitions-module__sending___uaLN-"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-components-icon-transitions");e||(e=document.createElement("style"),e.id="feedback-tool-styles-components-icon-transitions",document.head.appendChild(e)),e.textContent=Vg}var at=Kg;var Gg=({size:e=16})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 16 16",fill:"none",children:(0,Q.jsx)("path",{d:"M8 3v10M3 8h10",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})});var qg=({size:e=24,style:t={}})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",style:t,children:[(0,Q.jsxs)("g",{clipPath:"url(#clip0_list_sparkle)",children:[(0,Q.jsx)("path",{d:"M11.5 12L5.5 12",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M18.5 6.75L5.5 6.75",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M9.25 17.25L5.5 17.25",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M16 12.75L16.5179 13.9677C16.8078 14.6494 17.3506 15.1922 18.0323 15.4821L19.25 16L18.0323 16.5179C17.3506 16.8078 16.8078 17.3506 16.5179 18.0323L16 19.25L15.4821 18.0323C15.1922 17.3506 14.6494 16.8078 13.9677 16.5179L12.75 16L13.9677 15.4821C14.6494 15.1922 15.1922 14.6494 15.4821 13.9677L16 12.75Z",stroke:"currentColor",strokeWidth:"1.5",strokeLinejoin:"round"})]}),(0,Q.jsx)("defs",{children:(0,Q.jsx)("clipPath",{id:"clip0_list_sparkle",children:(0,Q.jsx)("rect",{width:"24",height:"24",fill:"white"})})})]}),Zg=({size:e=20,...t})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 20 20",fill:"none",xmlns:"http://www.w3.org/2000/svg",...t,children:[(0,Q.jsx)("circle",{cx:"10",cy:"10",r:"5.375",stroke:"currentColor",strokeWidth:"1.25"}),(0,Q.jsx)("path",{d:"M8.5 8.5C8.73 7.85 9.31 7.49 10 7.5C10.86 7.51 11.5 8.13 11.5 9C11.5 10.08 10 10.5 10 10.5V10.75",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("circle",{cx:"10",cy:"12.625",r:"0.625",fill:"currentColor"})]});var Jg=({size:e=24,copied:t=!1,tint:n})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",style:n?{color:n,transition:"color 0.3s ease"}:void 0,children:[(0,Q.jsxs)("g",{className:`${at.iconState} ${t?at.hiddenScaled:at.visibleScaled}`,children:[(0,Q.jsx)("path",{d:"M4.75 11.25C4.75 10.4216 5.42157 9.75 6.25 9.75H12.75C13.5784 9.75 14.25 10.4216 14.25 11.25V17.75C14.25 18.5784 13.5784 19.25 12.75 19.25H6.25C5.42157 19.25 4.75 18.5784 4.75 17.75V11.25Z",stroke:"currentColor",strokeWidth:"1.5"}),(0,Q.jsx)("path",{d:"M17.25 14.25H17.75C18.5784 14.25 19.25 13.5784 19.25 12.75V6.25C19.25 5.42157 18.5784 4.75 17.75 4.75H11.25C10.4216 4.75 9.75 5.42157 9.75 6.25V6.75",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]}),(0,Q.jsxs)("g",{className:`${at.iconState} ${t?at.visibleScaled:at.hiddenScaled}`,children:[(0,Q.jsx)("path",{d:"M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",stroke:"var(--agentation-color-green)",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M15 10L11 14.25L9.25 12.25",stroke:"var(--agentation-color-green)",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})]})]}),ey=({size:e=24,state:t="idle"})=>{let n=t==="idle",o=t==="sent",r=t==="failed",l=t==="sending";return(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[(0,Q.jsx)("g",{className:`${at.iconStateFast} ${n?at.visibleScaled:l?at.sending:at.hiddenScaled}`,children:(0,Q.jsx)("path",{d:"M9.875 14.125L12.3506 19.6951C12.7184 20.5227 13.9091 20.4741 14.2083 19.6193L18.8139 6.46032C19.0907 5.6695 18.3305 4.90933 17.5397 5.18611L4.38072 9.79174C3.52589 10.0909 3.47731 11.2816 4.30494 11.6494L9.875 14.125ZM9.875 14.125L13.375 10.625",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})}),(0,Q.jsxs)("g",{className:`${at.iconStateFast} ${o?at.visibleScaled:at.hiddenScaled}`,children:[(0,Q.jsx)("path",{d:"M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",stroke:"var(--agentation-color-green)",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M15 10L11 14.25L9.25 12.25",stroke:"var(--agentation-color-green)",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})]}),(0,Q.jsxs)("g",{className:`${at.iconStateFast} ${r?at.visibleScaled:at.hiddenScaled}`,children:[(0,Q.jsx)("path",{d:"M12 20C7.58172 20 4 16.4182 4 12C4 7.58172 7.58172 4 12 4C16.4182 4 20 7.58172 20 12C20 16.4182 16.4182 20 12 20Z",stroke:"var(--agentation-color-red)",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M12 8V12",stroke:"var(--agentation-color-red)",strokeWidth:"1.5",strokeLinecap:"round"}),(0,Q.jsx)("circle",{cx:"12",cy:"15",r:"0.5",fill:"var(--agentation-color-red)",stroke:"var(--agentation-color-red)",strokeWidth:"1"})]})]})};var ty=({size:e=24,isOpen:t=!0})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[(0,Q.jsxs)("g",{className:`${at.iconFade} ${t?at.visible:at.hidden}`,children:[(0,Q.jsx)("path",{d:"M3.91752 12.7539C3.65127 12.2996 3.65037 11.7515 3.9149 11.2962C4.9042 9.59346 7.72688 5.49994 12 5.49994C16.2731 5.49994 19.0958 9.59346 20.0851 11.2962C20.3496 11.7515 20.3487 12.2996 20.0825 12.7539C19.0908 14.4459 16.2694 18.4999 12 18.4999C7.73064 18.4999 4.90918 14.4459 3.91752 12.7539Z",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M12 14.8261C13.5608 14.8261 14.8261 13.5608 14.8261 12C14.8261 10.4392 13.5608 9.17392 12 9.17392C10.4392 9.17392 9.17391 10.4392 9.17391 12C9.17391 13.5608 10.4392 14.8261 12 14.8261Z",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})]}),(0,Q.jsxs)("g",{className:`${at.iconFade} ${t?at.hidden:at.visible}`,children:[(0,Q.jsx)("path",{d:"M18.6025 9.28503C18.9174 8.9701 19.4364 8.99481 19.7015 9.35271C20.1484 9.95606 20.4943 10.507 20.7342 10.9199C21.134 11.6086 21.1329 12.4454 20.7303 13.1328C20.2144 14.013 19.2151 15.5225 17.7723 16.8193C16.3293 18.1162 14.3852 19.2497 12.0008 19.25C11.4192 19.25 10.8638 19.1823 10.3355 19.0613C9.77966 18.934 9.63498 18.2525 10.0382 17.8493C10.2412 17.6463 10.5374 17.573 10.8188 17.6302C11.1993 17.7076 11.5935 17.75 12.0008 17.75C13.8848 17.7497 15.4867 16.8568 16.7693 15.7041C18.0522 14.5511 18.9606 13.1867 19.4363 12.375C19.5656 12.1543 19.5659 11.8943 19.4373 11.6729C19.2235 11.3049 18.921 10.8242 18.5364 10.3003C18.3085 9.98991 18.3302 9.5573 18.6025 9.28503ZM12.0008 4.75C12.5814 4.75006 13.1358 4.81803 13.6632 4.93953C14.2182 5.06741 14.362 5.74812 13.9593 6.15091C13.7558 6.35435 13.4589 6.42748 13.1771 6.36984C12.7983 6.29239 12.4061 6.25006 12.0008 6.25C10.1167 6.25 8.51415 7.15145 7.23028 8.31543C5.94678 9.47919 5.03918 10.8555 4.56426 11.6729C4.43551 11.8945 4.43582 12.1542 4.56524 12.375C4.77587 12.7343 5.07189 13.2012 5.44718 13.7105C5.67623 14.0213 5.65493 14.4552 5.38193 14.7282C5.0671 15.0431 4.54833 15.0189 4.28292 14.6614C3.84652 14.0736 3.50813 13.5369 3.27129 13.1328C2.86831 12.4451 2.86717 11.6088 3.26739 10.9199C3.78185 10.0345 4.77959 8.51239 6.22247 7.2041C7.66547 5.89584 9.61202 4.75 12.0008 4.75Z",fill:"currentColor"}),(0,Q.jsx)("path",{d:"M5 19L19 5",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]})]}),ny=({size:e=24,isPaused:t=!1})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[(0,Q.jsxs)("g",{className:`${at.iconFadeFast} ${t?at.hidden:at.visible}`,children:[(0,Q.jsx)("path",{d:"M8 6L8 18",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"}),(0,Q.jsx)("path",{d:"M16 18L16 6",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round"})]}),(0,Q.jsx)("path",{className:`${at.iconFadeFast} ${t?at.visible:at.hidden}`,d:"M17.75 10.701C18.75 11.2783 18.75 12.7217 17.75 13.299L8.75 18.4952C7.75 19.0725 6.5 18.3509 6.5 17.1962L6.5 6.80384C6.5 5.64914 7.75 4.92746 8.75 5.50481L17.75 10.701Z",stroke:"currentColor",strokeWidth:"1.5"})]});var oy=({size:e=16})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[(0,Q.jsx)("path",{d:"M10.6504 5.81117C10.9939 4.39628 13.0061 4.39628 13.3496 5.81117C13.5715 6.72517 14.6187 7.15891 15.4219 6.66952C16.6652 5.91193 18.0881 7.33479 17.3305 8.57815C16.8411 9.38134 17.2748 10.4285 18.1888 10.6504C19.6037 10.9939 19.6037 13.0061 18.1888 13.3496C17.2748 13.5715 16.8411 14.6187 17.3305 15.4219C18.0881 16.6652 16.6652 18.0881 15.4219 17.3305C14.6187 16.8411 13.5715 17.2748 13.3496 18.1888C13.0061 19.6037 10.9939 19.6037 10.6504 18.1888C10.4285 17.2748 9.38135 16.8411 8.57815 17.3305C7.33479 18.0881 5.91193 16.6652 6.66952 15.4219C7.15891 14.6187 6.72517 13.5715 5.81117 13.3496C4.39628 13.0061 4.39628 10.9939 5.81117 10.6504C6.72517 10.4285 7.15891 9.38134 6.66952 8.57815C5.91193 7.33479 7.33479 5.91192 8.57815 6.66952C9.38135 7.15891 10.4285 6.72517 10.6504 5.81117Z",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("circle",{cx:"12",cy:"12",r:"2.5",stroke:"currentColor",strokeWidth:"1.5"})]});var ry=({size:e=16})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:(0,Q.jsx)("path",{d:"M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4384 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z",fill:"currentColor"})});var xp=({size:e=16})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[(0,Q.jsxs)("g",{clipPath:"url(#clip0_2_53)",children:[(0,Q.jsx)("path",{d:"M16.25 16.25L7.75 7.75",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M7.75 16.25L16.25 7.75",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})]}),(0,Q.jsx)("defs",{children:(0,Q.jsx)("clipPath",{id:"clip0_2_53",children:(0,Q.jsx)("rect",{width:"24",height:"24",fill:"white"})})})]}),ly=({size:e=24})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:(0,Q.jsx)("path",{d:"M16.7198 6.21973C17.0127 5.92683 17.4874 5.92683 17.7803 6.21973C18.0732 6.51262 18.0732 6.9874 17.7803 7.28027L13.0606 12L17.7803 16.7197C18.0732 17.0126 18.0732 17.4874 17.7803 17.7803C17.4875 18.0731 17.0127 18.0731 16.7198 17.7803L12.0001 13.0605L7.28033 17.7803C6.98746 18.0731 6.51268 18.0731 6.21979 17.7803C5.92689 17.4874 5.92689 17.0126 6.21979 16.7197L10.9395 12L6.21979 7.28027C5.92689 6.98738 5.92689 6.51262 6.21979 6.21973C6.51268 5.92683 6.98744 5.92683 7.28033 6.21973L12.0001 10.9395L16.7198 6.21973Z",fill:"currentColor"})}),iy=({size:e=16})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 20 20",fill:"none",children:[(0,Q.jsx)("path",{d:"M9.99999 12.7082C11.4958 12.7082 12.7083 11.4956 12.7083 9.99984C12.7083 8.50407 11.4958 7.2915 9.99999 7.2915C8.50422 7.2915 7.29166 8.50407 7.29166 9.99984C7.29166 11.4956 8.50422 12.7082 9.99999 12.7082Z",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M10 3.9585V5.05698",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M10 14.9429V16.0414",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M5.7269 5.72656L6.50682 6.50649",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M13.4932 13.4932L14.2731 14.2731",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M3.95834 10H5.05683",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M14.9432 10H16.0417",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M5.7269 14.2731L6.50682 13.4932",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"}),(0,Q.jsx)("path",{d:"M13.4932 6.50649L14.2731 5.72656",stroke:"currentColor",strokeWidth:"1.25",strokeLinecap:"round",strokeLinejoin:"round"})]}),sy=({size:e=16})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 20 20",fill:"none",children:(0,Q.jsx)("path",{d:"M15.5 10.4955C15.4037 11.5379 15.0124 12.5314 14.3721 13.3596C13.7317 14.1878 12.8688 14.8165 11.8841 15.1722C10.8995 15.5278 9.83397 15.5957 8.81217 15.3679C7.79038 15.1401 6.8546 14.6259 6.11434 13.8857C5.37408 13.1454 4.85995 12.2096 4.63211 11.1878C4.40427 10.166 4.47215 9.10048 4.82781 8.11585C5.18346 7.13123 5.81218 6.26825 6.64039 5.62791C7.4686 4.98756 8.46206 4.59634 9.5045 4.5C8.89418 5.32569 8.60049 6.34302 8.67685 7.36695C8.75321 8.39087 9.19454 9.35339 9.92058 10.0794C10.6466 10.8055 11.6091 11.2468 12.6331 11.3231C13.657 11.3995 14.6743 11.1058 15.5 10.4955Z",stroke:"currentColor",strokeWidth:"1.13793",strokeLinecap:"round",strokeLinejoin:"round"})}),ay=({size:e=16})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 16 16",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:(0,Q.jsx)("path",{d:"M11.3799 6.9572L9.05645 4.63375M11.3799 6.9572L6.74949 11.5699C6.61925 11.6996 6.45577 11.791 6.277 11.8339L4.29549 12.3092C3.93194 12.3964 3.60478 12.0683 3.69297 11.705L4.16585 9.75693C4.20893 9.57947 4.29978 9.4172 4.42854 9.28771L9.05645 4.63375M11.3799 6.9572L12.3455 5.98759C12.9839 5.34655 12.9839 4.31002 12.3455 3.66897C11.7033 3.02415 10.6594 3.02415 10.0172 3.66897L9.06126 4.62892L9.05645 4.63375",stroke:"currentColor",strokeWidth:"0.9",strokeLinecap:"round",strokeLinejoin:"round"})}),cy=({size:e=24})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:(0,Q.jsx)("path",{d:"M13.5 4C14.7426 4 15.75 5.00736 15.75 6.25V7H18.5C18.9142 7 19.25 7.33579 19.25 7.75C19.25 8.16421 18.9142 8.5 18.5 8.5H17.9678L17.6328 16.2217C17.61 16.7475 17.5912 17.1861 17.5469 17.543C17.5015 17.9087 17.4225 18.2506 17.2461 18.5723C16.9747 19.0671 16.5579 19.4671 16.0518 19.7168C15.7227 19.8791 15.3772 19.9422 15.0098 19.9717C14.6514 20.0004 14.2126 20 13.6865 20H10.3135C9.78735 20 9.34856 20.0004 8.99023 19.9717C8.62278 19.9422 8.27729 19.8791 7.94824 19.7168C7.44205 19.4671 7.02532 19.0671 6.75391 18.5723C6.57751 18.2506 6.49853 17.9087 6.45312 17.543C6.40883 17.1861 6.39005 16.7475 6.36719 16.2217L6.03223 8.5H5.5C5.08579 8.5 4.75 8.16421 4.75 7.75C4.75 7.33579 5.08579 7 5.5 7H8.25V6.25C8.25 5.00736 9.25736 4 10.5 4H13.5ZM7.86621 16.1562C7.89013 16.7063 7.90624 17.0751 7.94141 17.3584C7.97545 17.6326 8.02151 17.7644 8.06934 17.8516C8.19271 18.0763 8.38239 18.2577 8.6123 18.3711C8.70153 18.4151 8.83504 18.4545 9.11035 18.4766C9.39482 18.4994 9.76335 18.5 10.3135 18.5H13.6865C14.2367 18.5 14.6052 18.4994 14.8896 18.4766C15.165 18.4545 15.2985 18.4151 15.3877 18.3711C15.6176 18.2577 15.8073 18.0763 15.9307 17.8516C15.9785 17.7644 16.0245 17.6326 16.0586 17.3584C16.0938 17.0751 16.1099 16.7063 16.1338 16.1562L16.4668 8.5H7.5332L7.86621 16.1562ZM9.97656 10.75C10.3906 10.7371 10.7371 11.0626 10.75 11.4766L10.875 15.4766C10.8879 15.8906 10.5624 16.2371 10.1484 16.25C9.73443 16.2629 9.38794 15.9374 9.375 15.5234L9.25 11.5234C9.23706 11.1094 9.56255 10.7629 9.97656 10.75ZM14.0244 10.75C14.4383 10.7635 14.7635 11.1105 14.75 11.5244L14.6201 15.5244C14.6066 15.9384 14.2596 16.2634 13.8457 16.25C13.4317 16.2365 13.1067 15.8896 13.1201 15.4756L13.251 11.4756C13.2645 11.0617 13.6105 10.7366 14.0244 10.75ZM10.5 5.5C10.0858 5.5 9.75 5.83579 9.75 6.25V7H14.25V6.25C14.25 5.83579 13.9142 5.5 13.5 5.5H10.5Z",fill:"currentColor"})}),dy=({size:e=16})=>(0,Q.jsx)("svg",{width:e,height:e,viewBox:"0 0 16 16",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:(0,Q.jsx)("path",{d:"M8.5 3.5L4 8L8.5 12.5",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})});var uy=({size:e=24})=>(0,Q.jsxs)("svg",{width:e,height:e,viewBox:"0 0 24 24",fill:"none",children:[(0,Q.jsx)("rect",{x:"3",y:"3",width:"18",height:"18",rx:"2",stroke:"currentColor",strokeWidth:"1.5"}),(0,Q.jsx)("line",{x1:"3",y1:"9",x2:"21",y2:"9",stroke:"currentColor",strokeWidth:"1.5"}),(0,Q.jsx)("line",{x1:"9",y1:"9",x2:"9",y2:"21",stroke:"currentColor",strokeWidth:"1.5"})]}),vp=["data-feedback-toolbar","data-annotation-popup","data-annotation-marker"],hu=vp.flatMap(e=>[`:not([${e}])`,`:not([${e}] *)`]).join(""),Mu="feedback-freeze-styles",pu="__agentation_freeze";function _y(){if(typeof window>"u")return{frozen:!1,installed:!0,origSetTimeout:setTimeout,origSetInterval:setInterval,origRAF:t=>0,pausedAnimations:[],frozenTimeoutQueue:[],frozenRAFQueue:[]};let e=window;return e[pu]||(e[pu]={frozen:!1,installed:!1,origSetTimeout:null,origSetInterval:null,origRAF:null,pausedAnimations:[],frozenTimeoutQueue:[],frozenRAFQueue:[]}),e[pu]}var Be=_y();typeof window<"u"&&!Be.installed&&(Be.origSetTimeout=window.setTimeout.bind(window),Be.origSetInterval=window.setInterval.bind(window),Be.origRAF=window.requestAnimationFrame.bind(window),window.setTimeout=(e,t,...n)=>typeof e=="string"?Be.origSetTimeout(e,t):Be.origSetTimeout((...o)=>{Be.frozen?Be.frozenTimeoutQueue.push(()=>e(...o)):e(...o)},t,...n),window.setInterval=(e,t,...n)=>typeof e=="string"?Be.origSetInterval(e,t):Be.origSetInterval((...o)=>{Be.frozen||e(...o)},t,...n),window.requestAnimationFrame=e=>Be.origRAF(t=>{Be.frozen?Be.frozenRAFQueue.push(e):e(t)}),Be.installed=!0);var fe=Be.origSetTimeout,fy=Be.origSetInterval,vl=Be.origRAF;function hy(e){return e?vp.some(t=>!!e.closest?.(`[${t}]`)):!1}function py(){if(typeof document>"u"||Be.frozen)return;Be.frozen=!0,Be.frozenTimeoutQueue=[],Be.frozenRAFQueue=[];let e=document.getElementById(Mu);e||(e=document.createElement("style"),e.id=Mu),e.textContent=`
    *${hu},
    *${hu}::before,
    *${hu}::after {
      animation-play-state: paused !important;
      transition: none !important;
    }
  `,document.head.appendChild(e),Be.pausedAnimations=[];try{document.getAnimations().forEach(t=>{if(t.playState!=="running")return;let n=t.effect?.target;hy(n)||(t.pause(),Be.pausedAnimations.push(t))})}catch{}document.querySelectorAll("video").forEach(t=>{t.paused||(t.dataset.wasPaused="false",t.pause())})}function Qh(){if(typeof document>"u"||!Be.frozen)return;Be.frozen=!1;let e=Be.frozenTimeoutQueue;Be.frozenTimeoutQueue=[];for(let n of e)Be.origSetTimeout(()=>{if(Be.frozen){Be.frozenTimeoutQueue.push(n);return}try{n()}catch(o){console.warn("[agentation] Error replaying queued timeout:",o)}},0);let t=Be.frozenRAFQueue;Be.frozenRAFQueue=[];for(let n of t)Be.origRAF(o=>{if(Be.frozen){Be.frozenRAFQueue.push(n);return}n(o)});for(let n of Be.pausedAnimations)try{n.play()}catch(o){console.warn("[agentation] Error resuming animation:",o)}Be.pausedAnimations=[],document.getElementById(Mu)?.remove(),document.querySelectorAll("video").forEach(n=>{n.dataset.wasPaused==="false"&&(n.play().catch(()=>{}),delete n.dataset.wasPaused)})}function mu(e){if(!e)return;let t=n=>n.stopImmediatePropagation();document.addEventListener("focusin",t,!0),document.addEventListener("focusout",t,!0);try{e.focus()}finally{document.removeEventListener("focusin",t,!0),document.removeEventListener("focusout",t,!0)}}var $a=(0,Ct.forwardRef)(function({element:t,timestamp:n,selectedText:o,placeholder:r="What should change?",initialValue:l="",submitLabel:i="Add",onSubmit:s,onCancel:a,onDelete:m,style:p,accentColor:b="#3c82f7",isExiting:y=!1,lightMode:$=!1,computedStyles:C},I){let[E,f]=(0,Ct.useState)(l),[g,w]=(0,Ct.useState)(!1),[N,H]=(0,Ct.useState)("initial"),[V,D]=(0,Ct.useState)(!1),[G,ye]=(0,Ct.useState)(!1),Z=(0,Ct.useRef)(null),he=(0,Ct.useRef)(null),Ge=(0,Ct.useRef)(null),it=(0,Ct.useRef)(null);(0,Ct.useEffect)(()=>{y&&N!=="exit"&&H("exit")},[y,N]),(0,Ct.useEffect)(()=>{fe(()=>{H("enter")},0);let me=fe(()=>{H("entered")},200),Ue=fe(()=>{let Mt=Z.current;Mt&&(mu(Mt),Mt.selectionStart=Mt.selectionEnd=Mt.value.length,Mt.scrollTop=Mt.scrollHeight)},50);return()=>{clearTimeout(me),clearTimeout(Ue),Ge.current&&clearTimeout(Ge.current),it.current&&clearTimeout(it.current)}},[]);let Re=(0,Ct.useCallback)(()=>{it.current&&clearTimeout(it.current),w(!0),it.current=fe(()=>{w(!1),mu(Z.current)},250)},[]);(0,Ct.useImperativeHandle)(I,()=>({shake:Re}),[Re]);let We=(0,Ct.useCallback)(()=>{H("exit"),Ge.current=fe(()=>{a()},150)},[a]),Ee=(0,Ct.useCallback)(()=>{E.trim()&&s(E.trim())},[E,s]),Ke=(0,Ct.useCallback)(me=>{me.stopPropagation(),!me.nativeEvent.isComposing&&(me.key==="Enter"&&!me.shiftKey&&(me.preventDefault(),Ee()),me.key==="Escape"&&We())},[Ee,We]),X=[ct.popup,$?ct.light:"",N==="enter"?ct.enter:"",N==="entered"?ct.entered:"",N==="exit"?ct.exit:"",g?ct.shake:""].filter(Boolean).join(" ");return(0,yt.jsxs)("div",{ref:he,className:X,"data-annotation-popup":!0,style:p,onClick:me=>me.stopPropagation(),children:[(0,yt.jsxs)("div",{className:ct.header,children:[C&&Object.keys(C).length>0?(0,yt.jsxs)("button",{className:ct.headerToggle,onClick:()=>{let me=G;ye(!G),me&&fe(()=>mu(Z.current),0)},type:"button",children:[(0,yt.jsx)("svg",{className:`${ct.chevron} ${G?ct.expanded:""}`,width:"14",height:"14",viewBox:"0 0 14 14",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:(0,yt.jsx)("path",{d:"M5.5 10.25L9 7.25L5.75 4",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})}),(0,yt.jsx)("span",{className:ct.element,children:t})]}):(0,yt.jsx)("span",{className:ct.element,children:t}),n&&(0,yt.jsx)("span",{className:ct.timestamp,children:n})]}),C&&Object.keys(C).length>0&&(0,yt.jsx)("div",{className:`${ct.stylesWrapper} ${G?ct.expanded:""}`,children:(0,yt.jsx)("div",{className:ct.stylesInner,children:(0,yt.jsx)("div",{className:ct.stylesBlock,children:Object.entries(C).map(([me,Ue])=>(0,yt.jsxs)("div",{className:ct.styleLine,children:[(0,yt.jsx)("span",{className:ct.styleProperty,children:me.replace(/([A-Z])/g,"-$1").toLowerCase()}),": ",(0,yt.jsx)("span",{className:ct.styleValue,children:Ue}),";"]},me))})})}),o&&(0,yt.jsxs)("div",{className:ct.quote,children:["\u201C",o.slice(0,80),o.length>80?"...":"","\u201D"]}),(0,yt.jsx)("textarea",{ref:Z,className:ct.textarea,style:{borderColor:V?b:void 0},placeholder:r,value:E,onChange:me=>f(me.target.value),onFocus:()=>D(!0),onBlur:()=>D(!1),rows:2,onKeyDown:Ke}),(0,yt.jsxs)("div",{className:ct.actions,children:[m&&(0,yt.jsx)("div",{className:ct.deleteWrapper,children:(0,yt.jsx)("button",{className:ct.deleteButton,onClick:m,type:"button",children:(0,yt.jsx)(cy,{size:22})})}),(0,yt.jsx)("button",{className:ct.cancel,onClick:We,children:"Cancel"}),(0,yt.jsx)("button",{className:ct.submit,style:{backgroundColor:b,opacity:E.trim()?1:.4},onClick:Ee,disabled:!E.trim(),children:i})]})]})}),my=({content:e,children:t,...n})=>{let[o,r]=(0,po.useState)(!1),[l,i]=(0,po.useState)(!1),[s,a]=(0,po.useState)({top:0,right:0}),m=(0,po.useRef)(null),p=(0,po.useRef)(null),b=(0,po.useRef)(null),y=()=>{if(m.current){let I=m.current.getBoundingClientRect();a({top:I.top+I.height/2,right:window.innerWidth-I.left+8})}},$=()=>{i(!0),b.current&&(clearTimeout(b.current),b.current=null),y(),p.current=fe(()=>{r(!0)},500)},C=()=>{p.current&&(clearTimeout(p.current),p.current=null),r(!1),b.current=fe(()=>{i(!1)},150)};return(0,po.useEffect)(()=>()=>{p.current&&clearTimeout(p.current),b.current&&clearTimeout(b.current)},[]),(0,$r.jsxs)($r.Fragment,{children:[(0,$r.jsx)("span",{ref:m,onMouseEnter:$,onMouseLeave:C,...n,children:t}),l&&(0,wp.createPortal)((0,$r.jsx)("div",{"data-feedback-toolbar":!0,style:{position:"fixed",top:s.top,right:s.right,transform:"translateY(-50%)",padding:"6px 10px",background:"#383838",color:"rgba(255, 255, 255, 0.7)",fontSize:"11px",fontWeight:400,lineHeight:"14px",borderRadius:"10px",width:"180px",textAlign:"left",zIndex:100020,pointerEvents:"none",boxShadow:"0px 1px 8px rgba(0, 0, 0, 0.28)",opacity:o?1:0,transition:"opacity 0.15s ease"},children:e}),document.body)]})},gy=`.styles-module__tooltip___mcXL2 {
  display: flex;
  justify-content: center;
  align-items: center;
  cursor: help;
}

.styles-module__tooltipIcon___Nq2nD {
  transform: translateY(0.5px);
  color: #fff;
  opacity: 0.2;
  transition: opacity 0.15s ease;
  will-change: transform;
}
.styles-module__tooltip___mcXL2:hover .styles-module__tooltipIcon___Nq2nD {
  opacity: 0.5;
}
[data-agentation-theme=light] .styles-module__tooltipIcon___Nq2nD {
  color: #000;
}`,yy={tooltip:"styles-module__tooltip___mcXL2",tooltipIcon:"styles-module__tooltipIcon___Nq2nD"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-help-tooltip-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-help-tooltip-styles",document.head.appendChild(e)),e.textContent=gy}var Vh=yy,Nr=({content:e})=>(0,Eu.jsx)(my,{className:Vh.tooltip,content:e,children:(0,Eu.jsx)(Zg,{className:Vh.tooltipIcon})}),ee={navigation:{width:800,height:56},hero:{width:800,height:320},header:{width:800,height:80},section:{width:800,height:400},sidebar:{width:240,height:400},footer:{width:800,height:160},modal:{width:480,height:300},card:{width:280,height:240},text:{width:400,height:120},image:{width:320,height:200},video:{width:480,height:270},table:{width:560,height:220},grid:{width:600,height:300},list:{width:300,height:180},chart:{width:400,height:240},button:{width:140,height:40},input:{width:280,height:56},form:{width:360,height:320},tabs:{width:480,height:240},dropdown:{width:200,height:200},toggle:{width:44,height:24},search:{width:320,height:44},avatar:{width:48,height:48},badge:{width:80,height:28},breadcrumb:{width:300,height:24},pagination:{width:300,height:36},progress:{width:240,height:8},divider:{width:600,height:1},accordion:{width:400,height:200},carousel:{width:600,height:300},toast:{width:320,height:64},tooltip:{width:180,height:40},pricing:{width:300,height:360},testimonial:{width:360,height:200},cta:{width:600,height:160},alert:{width:400,height:56},banner:{width:800,height:48},stat:{width:200,height:120},stepper:{width:480,height:48},tag:{width:72,height:28},rating:{width:160,height:28},map:{width:480,height:300},timeline:{width:360,height:320},fileUpload:{width:360,height:180},codeBlock:{width:480,height:200},calendar:{width:300,height:300},notification:{width:360,height:72},productCard:{width:280,height:360},profile:{width:280,height:200},drawer:{width:320,height:400},popover:{width:240,height:160},logo:{width:120,height:40},faq:{width:560,height:320},gallery:{width:560,height:360},checkbox:{width:20,height:20},radio:{width:20,height:20},slider:{width:240,height:32},datePicker:{width:300,height:320},skeleton:{width:320,height:120},chip:{width:96,height:32},icon:{width:24,height:24},spinner:{width:32,height:32},feature:{width:360,height:200},team:{width:560,height:280},login:{width:360,height:360},contact:{width:400,height:320}},bp=[{section:"Layout",items:[{type:"navigation",label:"Navigation",...ee.navigation},{type:"header",label:"Header",...ee.header},{type:"hero",label:"Hero",...ee.hero},{type:"section",label:"Section",...ee.section},{type:"sidebar",label:"Sidebar",...ee.sidebar},{type:"footer",label:"Footer",...ee.footer},{type:"modal",label:"Modal",...ee.modal},{type:"banner",label:"Banner",...ee.banner},{type:"drawer",label:"Drawer",...ee.drawer},{type:"popover",label:"Popover",...ee.popover},{type:"divider",label:"Divider",...ee.divider}]},{section:"Content",items:[{type:"card",label:"Card",...ee.card},{type:"text",label:"Text",...ee.text},{type:"image",label:"Image",...ee.image},{type:"video",label:"Video",...ee.video},{type:"table",label:"Table",...ee.table},{type:"grid",label:"Grid",...ee.grid},{type:"list",label:"List",...ee.list},{type:"chart",label:"Chart",...ee.chart},{type:"codeBlock",label:"Code Block",...ee.codeBlock},{type:"map",label:"Map",...ee.map},{type:"timeline",label:"Timeline",...ee.timeline},{type:"calendar",label:"Calendar",...ee.calendar},{type:"accordion",label:"Accordion",...ee.accordion},{type:"carousel",label:"Carousel",...ee.carousel},{type:"logo",label:"Logo",...ee.logo},{type:"faq",label:"FAQ",...ee.faq},{type:"gallery",label:"Gallery",...ee.gallery}]},{section:"Controls",items:[{type:"button",label:"Button",...ee.button},{type:"input",label:"Input",...ee.input},{type:"search",label:"Search",...ee.search},{type:"form",label:"Form",...ee.form},{type:"tabs",label:"Tabs",...ee.tabs},{type:"dropdown",label:"Dropdown",...ee.dropdown},{type:"toggle",label:"Toggle",...ee.toggle},{type:"stepper",label:"Stepper",...ee.stepper},{type:"rating",label:"Rating",...ee.rating},{type:"fileUpload",label:"File Upload",...ee.fileUpload},{type:"checkbox",label:"Checkbox",...ee.checkbox},{type:"radio",label:"Radio",...ee.radio},{type:"slider",label:"Slider",...ee.slider},{type:"datePicker",label:"Date Picker",...ee.datePicker}]},{section:"Elements",items:[{type:"avatar",label:"Avatar",...ee.avatar},{type:"badge",label:"Badge",...ee.badge},{type:"tag",label:"Tag",...ee.tag},{type:"breadcrumb",label:"Breadcrumb",...ee.breadcrumb},{type:"pagination",label:"Pagination",...ee.pagination},{type:"progress",label:"Progress",...ee.progress},{type:"alert",label:"Alert",...ee.alert},{type:"toast",label:"Toast",...ee.toast},{type:"notification",label:"Notification",...ee.notification},{type:"tooltip",label:"Tooltip",...ee.tooltip},{type:"stat",label:"Stat",...ee.stat},{type:"skeleton",label:"Skeleton",...ee.skeleton},{type:"chip",label:"Chip",...ee.chip},{type:"icon",label:"Icon",...ee.icon},{type:"spinner",label:"Spinner",...ee.spinner}]},{section:"Blocks",items:[{type:"pricing",label:"Pricing",...ee.pricing},{type:"testimonial",label:"Testimonial",...ee.testimonial},{type:"cta",label:"CTA",...ee.cta},{type:"productCard",label:"Product Card",...ee.productCard},{type:"profile",label:"Profile",...ee.profile},{type:"feature",label:"Feature",...ee.feature},{type:"team",label:"Team",...ee.team},{type:"login",label:"Login",...ee.login},{type:"contact",label:"Contact",...ee.contact}]}],Jn={};for(let e of bp)for(let t of e.items)Jn[t.type]=t;function z({w:e,h:t=3,strong:n}){return(0,d.jsx)("div",{style:{width:typeof e=="number"?`${e}px`:e,height:t,borderRadius:2,background:n?"var(--agd-bar-strong)":"var(--agd-bar)",flexShrink:0}})}function lt({w:e,h:t,radius:n=3,style:o}){return(0,d.jsx)("div",{style:{width:typeof e=="number"?`${e}px`:e,height:typeof t=="number"?`${t}px`:t,borderRadius:n,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",flexShrink:0,...o}})}function an({size:e}){return(0,d.jsx)("div",{style:{width:e,height:e,borderRadius:"50%",border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",flexShrink:0}})}function xy({width:e,height:t}){let n=Math.max(8,t*.2);return(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",height:"100%",padding:`0 ${n}px`,gap:e*.02},children:[(0,d.jsx)(lt,{w:Math.max(20,t*.5),h:Math.max(12,t*.4),radius:2}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",gap:e*.03,marginLeft:e*.04},children:[(0,d.jsx)(z,{w:e*.06}),(0,d.jsx)(z,{w:e*.07}),(0,d.jsx)(z,{w:e*.05}),(0,d.jsx)(z,{w:e*.06})]}),(0,d.jsx)(lt,{w:e*.1,h:Math.min(28,t*.5),radius:4})]})}function vy({width:e,height:t,text:n}){return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:t*.05},children:[n?(0,d.jsx)("span",{style:{fontSize:Math.min(20,t*.08),fontWeight:600,color:"var(--agd-text-3)",textAlign:"center",maxWidth:"80%"},children:n}):(0,d.jsx)(z,{w:e*.5,h:Math.max(6,t*.04),strong:!0}),(0,d.jsx)(z,{w:e*.6}),(0,d.jsx)(z,{w:e*.4}),(0,d.jsx)(lt,{w:Math.min(140,e*.2),h:Math.min(36,t*.12),radius:6,style:{marginTop:t*.06}})]})}function wy({width:e,height:t}){let n=Math.max(3,Math.floor(t/36));return(0,d.jsxs)("div",{style:{padding:e*.08,display:"flex",flexDirection:"column",gap:t*.03},children:[(0,d.jsx)(z,{w:e*.6,h:4,strong:!0}),Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:6},children:[(0,d.jsx)(lt,{w:10,h:10,radius:2}),(0,d.jsx)(z,{w:e*(.4+r*17%30/100)})]},r))]})}function by({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(e/160)));return(0,d.jsx)("div",{style:{display:"flex",padding:`${t*.12}px ${e*.03}px`,gap:e*.05},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:4},children:[(0,d.jsx)(z,{w:"60%",h:3,strong:!0}),(0,d.jsx)(z,{w:"80%",h:2}),(0,d.jsx)(z,{w:"70%",h:2}),(0,d.jsx)(z,{w:"60%",h:2})]},r))})}function ky({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsxs)("div",{style:{padding:"10px 12px",borderBottom:"1px solid var(--agd-stroke)",display:"flex",alignItems:"center",justifyContent:"space-between"},children:[(0,d.jsx)(z,{w:e*.3,h:4,strong:!0}),(0,d.jsx)("div",{style:{width:14,height:14,border:"1px solid var(--agd-stroke)",borderRadius:3}})]}),(0,d.jsxs)("div",{style:{flex:1,padding:12,display:"flex",flexDirection:"column",gap:6},children:[(0,d.jsx)(z,{w:"90%"}),(0,d.jsx)(z,{w:"70%"}),(0,d.jsx)(z,{w:"80%"})]}),(0,d.jsxs)("div",{style:{padding:"10px 12px",borderTop:"1px solid var(--agd-stroke)",display:"flex",justifyContent:"flex-end",gap:8},children:[(0,d.jsx)(lt,{w:70,h:26,radius:4}),(0,d.jsx)(lt,{w:70,h:26,radius:4,style:{background:"var(--agd-bar)"}})]})]})}function Cy({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsx)("div",{style:{height:"40%",background:"var(--agd-fill)",borderBottom:"1px dashed var(--agd-stroke)"}}),(0,d.jsxs)("div",{style:{flex:1,padding:10,display:"flex",flexDirection:"column",gap:5},children:[(0,d.jsx)(z,{w:"70%",h:4,strong:!0}),(0,d.jsx)(z,{w:"95%",h:2}),(0,d.jsx)(z,{w:"85%",h:2}),(0,d.jsx)(z,{w:"50%",h:2})]})]})}function Sy({width:e,height:t,text:n}){if(n)return(0,d.jsx)("div",{style:{padding:4,fontSize:Math.min(14,t*.3),lineHeight:1.5,color:"var(--agd-text-3)",wordBreak:"break-word",overflow:"hidden"},children:n});let o=Math.max(2,Math.floor(t/18));return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:6,padding:4},children:[(0,d.jsx)(z,{w:e*.6,h:5,strong:!0}),Array.from({length:o},(r,l)=>(0,d.jsx)(z,{w:`${70+l*13%25}%`,h:2},l))]})}function My({width:e,height:t}){return(0,d.jsx)("div",{style:{height:"100%",position:"relative"},children:(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,preserveAspectRatio:"none",fill:"none",children:[(0,d.jsx)("line",{x1:"0",y1:"0",x2:e,y2:t,stroke:"var(--agd-stroke)",strokeWidth:"1"}),(0,d.jsx)("line",{x1:e,y1:"0",x2:"0",y2:t,stroke:"var(--agd-stroke)",strokeWidth:"1"}),(0,d.jsx)("circle",{cx:e*.3,cy:t*.3,r:Math.min(e,t)*.08,fill:"var(--agd-fill)",stroke:"var(--agd-stroke)",strokeWidth:"0.8"})]})})}function Ey({width:e,height:t}){let n=Math.max(2,Math.min(5,Math.floor(e/100))),o=Math.max(2,Math.min(6,Math.floor(t/32)));return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsx)("div",{style:{display:"flex",borderBottom:"1px solid var(--agd-stroke)",padding:"6px 0"},children:Array.from({length:n},(r,l)=>(0,d.jsx)("div",{style:{flex:1,padding:"0 8px"},children:(0,d.jsx)(z,{w:"70%",h:3,strong:!0})},l))}),Array.from({length:o},(r,l)=>(0,d.jsx)("div",{style:{display:"flex",borderBottom:"1px solid rgba(255,255,255,0.03)",padding:"6px 0"},children:Array.from({length:n},(i,s)=>(0,d.jsx)("div",{style:{flex:1,padding:"0 8px"},children:(0,d.jsx)(z,{w:`${50+(l*7+s*13)%40}%`,h:2})},s))},l))]})}function Ly({width:e,height:t}){let n=Math.max(2,Math.floor(t/28));return(0,d.jsx)("div",{style:{display:"flex",flexDirection:"column",gap:4,padding:4},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:8,padding:"4px 0"},children:[(0,d.jsx)(an,{size:8}),(0,d.jsx)(z,{w:`${55+r*17%35}%`,h:2})]},r))})}function Iy({width:e,height:t,text:n}){return(0,d.jsx)("div",{style:{height:"100%",borderRadius:Math.min(8,t/3),border:"1px solid var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",justifyContent:"center"},children:n?(0,d.jsx)("span",{style:{fontSize:Math.min(13,t*.4),fontWeight:500,color:"var(--agd-text-3)",letterSpacing:"-0.01em"},children:n}):(0,d.jsx)(z,{w:Math.max(20,e*.5),h:3,strong:!0})})}function Ny({width:e,height:t}){return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:4,height:"100%",justifyContent:"center"},children:[(0,d.jsx)(z,{w:Math.min(80,e*.3),h:2}),(0,d.jsx)("div",{style:{height:Math.min(36,t*.6),borderRadius:4,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",paddingLeft:8},children:(0,d.jsx)(z,{w:"40%",h:2})})]})}function $y({width:e,height:t}){let n=Math.max(2,Math.min(5,Math.floor(t/56)));return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:t*.04,padding:8},children:[Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:4},children:[(0,d.jsx)(z,{w:60+r*17%30,h:2}),(0,d.jsx)(lt,{w:"100%",h:28,radius:4})]},r)),(0,d.jsx)(lt,{w:Math.min(120,e*.35),h:30,radius:6,style:{marginTop:8,alignSelf:"flex-end",background:"var(--agd-bar)"}})]})}function Ry({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(e/120)));return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsx)("div",{style:{display:"flex",gap:2,borderBottom:"1px solid var(--agd-stroke)"},children:Array.from({length:n},(o,r)=>(0,d.jsx)("div",{style:{padding:"8px 12px",borderBottom:r===0?"2px solid var(--agd-bar-strong)":"none"},children:(0,d.jsx)(z,{w:60,h:3,strong:r===0})},r))}),(0,d.jsxs)("div",{style:{flex:1,padding:12,display:"flex",flexDirection:"column",gap:6},children:[(0,d.jsx)(z,{w:"80%",h:2}),(0,d.jsx)(z,{w:"65%",h:2}),(0,d.jsx)(z,{w:"75%",h:2})]})]})}function Ty({width:e,height:t}){let n=Math.min(e,t)/2;return(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:[(0,d.jsx)("circle",{cx:e/2,cy:t/2,r:n-1,stroke:"var(--agd-stroke)",fill:"var(--agd-fill)",strokeWidth:"1.5",strokeDasharray:"3 2"}),(0,d.jsx)("circle",{cx:e/2,cy:t*.38,r:n*.28,stroke:"var(--agd-stroke)",fill:"var(--agd-fill)",strokeWidth:"0.8"}),(0,d.jsx)("path",{d:`M${e/2-n*.55} ${t*.78} C${e/2-n*.55} ${t*.55} ${e/2+n*.55} ${t*.55} ${e/2+n*.55} ${t*.78}`,stroke:"var(--agd-stroke)",fill:"var(--agd-fill)",strokeWidth:"0.8"})]})}function Py({width:e,height:t}){return(0,d.jsx)("div",{style:{height:"100%",borderRadius:t/2,border:"1px solid var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",justifyContent:"center"},children:(0,d.jsx)(z,{w:Math.max(16,e*.5),h:2,strong:!0})})}function Dy({width:e,height:t}){return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:t*.08},children:[(0,d.jsx)(z,{w:e*.5,h:Math.max(5,t*.06),strong:!0}),(0,d.jsx)(z,{w:e*.35})]})}function By({width:e,height:t}){return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",height:"100%",gap:t*.04,padding:e*.04},children:[(0,d.jsx)(z,{w:e*.3,h:4,strong:!0}),(0,d.jsx)(z,{w:e*.7}),(0,d.jsx)(z,{w:e*.5}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",gap:e*.03,marginTop:t*.06},children:[(0,d.jsx)(lt,{w:"33%",h:"100%",radius:4}),(0,d.jsx)(lt,{w:"33%",h:"100%",radius:4}),(0,d.jsx)(lt,{w:"33%",h:"100%",radius:4})]})]})}function zy({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(e/140))),o=Math.max(1,Math.min(3,Math.floor(t/120)));return(0,d.jsx)("div",{style:{display:"grid",gridTemplateColumns:`repeat(${n}, 1fr)`,gridTemplateRows:`repeat(${o}, 1fr)`,gap:6,height:"100%"},children:Array.from({length:n*o},(r,l)=>(0,d.jsx)(lt,{w:"100%",h:"100%",radius:4},l))})}function Oy({width:e,height:t}){let n=Math.max(2,Math.floor((t-32)/28));return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsx)("div",{style:{padding:"6px 8px",borderBottom:"1px solid var(--agd-stroke)"},children:(0,d.jsx)(z,{w:e*.5,h:3,strong:!0})}),(0,d.jsx)("div",{style:{flex:1,padding:4,display:"flex",flexDirection:"column",gap:2},children:Array.from({length:n},(o,r)=>(0,d.jsx)("div",{style:{padding:"4px 6px",borderRadius:3,background:r===0?"var(--agd-fill)":"transparent"},children:(0,d.jsx)(z,{w:`${50+r*17%35}%`,h:2,strong:r===0})},r))})]})}function Ay({width:e,height:t}){let n=Math.min(e,t)/2;return(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:[(0,d.jsx)("rect",{x:"1",y:"1",width:e-2,height:t-2,rx:n,stroke:"var(--agd-stroke)",strokeWidth:"1"}),(0,d.jsx)("circle",{cx:e-n,cy:t/2,r:n*.7,fill:"var(--agd-bar)"})]})}function Wy({width:e,height:t}){let n=Math.min(t/2,20);return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:n,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",padding:`0 ${n*.6}px`,gap:6},children:[(0,d.jsx)(an,{size:Math.min(14,t*.4)}),(0,d.jsx)(z,{w:"50%",h:2})]})}function Fy({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:8,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",padding:"0 10px",gap:8},children:[(0,d.jsx)(an,{size:Math.min(20,t*.5)}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:"60%",h:3,strong:!0}),(0,d.jsx)(z,{w:"80%",h:2})]}),(0,d.jsx)("div",{style:{width:14,height:14,border:"1px solid var(--agd-stroke)",borderRadius:3,flexShrink:0}})]})}function jy({width:e,height:t}){return(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:[(0,d.jsx)("rect",{x:"0",y:"0",width:e,height:t,rx:t/2,stroke:"var(--agd-stroke)",strokeWidth:"0.8"}),(0,d.jsx)("rect",{x:"1",y:"1",width:e*.65,height:t-2,rx:(t-2)/2,fill:"var(--agd-bar)"})]})}function Hy({width:e,height:t}){let n=Math.max(3,Math.min(7,Math.floor(e/50))),o=e/(n*2);return(0,d.jsx)("div",{style:{height:"100%",display:"flex",alignItems:"flex-end",justifyContent:"space-around",padding:"0 4px",borderBottom:"1px solid var(--agd-stroke)"},children:Array.from({length:n},(r,l)=>{let i=30+(l*37+17)%55;return(0,d.jsx)(lt,{w:o,h:`${i}%`,radius:2},l)})})}function Uy({width:e,height:t}){let n=Math.min(e,t)*.12;return(0,d.jsxs)("div",{style:{height:"100%",position:"relative",display:"flex",alignItems:"center",justifyContent:"center"},children:[(0,d.jsx)(lt,{w:"100%",h:"100%",radius:4}),(0,d.jsx)("div",{style:{position:"absolute",width:n*2,height:n*2,borderRadius:"50%",border:"1.5px solid var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",justifyContent:"center"},children:(0,d.jsx)("div",{style:{width:0,height:0,borderLeft:`${n*.6}px solid var(--agd-bar-strong)`,borderTop:`${n*.4}px solid transparent`,borderBottom:`${n*.4}px solid transparent`,marginLeft:n*.15}})})]})}function Yy({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center"},children:[(0,d.jsx)("div",{style:{flex:1,width:"100%",borderRadius:6,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",justifyContent:"center"},children:(0,d.jsx)(z,{w:"60%",h:2})}),(0,d.jsx)("div",{style:{width:8,height:8,background:"var(--agd-fill)",border:"1px dashed var(--agd-stroke)",borderTop:"none",borderLeft:"none",transform:"rotate(45deg)",marginTop:-5}})]})}function Xy({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(e/80)));return(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",height:"100%",gap:4},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:4},children:[r>0&&(0,d.jsx)("span",{style:{color:"var(--agd-stroke)",fontSize:10},children:"/"}),(0,d.jsx)(z,{w:40+r*13%20,h:2,strong:r===n-1})]},r))})}function Qy({width:e,height:t}){let n=Math.max(3,Math.min(5,Math.floor(e/40))),o=Math.min(28,t*.8);return(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",gap:4},children:Array.from({length:n},(r,l)=>(0,d.jsx)(lt,{w:o,h:o,radius:4,style:l===1?{background:"var(--agd-bar)"}:void 0},l))})}function Vy({width:e}){return(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",height:"100%"},children:(0,d.jsx)("div",{style:{width:"100%",height:1,background:"var(--agd-stroke)"}})})}function Ky({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(t/40)));return(0,d.jsx)("div",{style:{display:"flex",flexDirection:"column",height:"100%"},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{borderBottom:"1px solid var(--agd-stroke)",padding:"8px 6px",display:"flex",alignItems:"center",justifyContent:"space-between",flex:r===0?2:1},children:[(0,d.jsx)(z,{w:`${40+r*17%25}%`,h:3,strong:!0}),(0,d.jsx)("span",{style:{fontSize:8,color:"var(--agd-stroke)"},children:r===0?"\u25BC":"\u25B6"})]},r))})}function Gy({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",gap:6},children:[(0,d.jsxs)("div",{style:{flex:1,display:"flex",gap:6,alignItems:"center"},children:[(0,d.jsx)("span",{style:{fontSize:12,color:"var(--agd-stroke)"},children:"\u2039"}),(0,d.jsx)(lt,{w:"100%",h:"100%",radius:4}),(0,d.jsx)("span",{style:{fontSize:12,color:"var(--agd-stroke)"},children:"\u203A"})]}),(0,d.jsxs)("div",{style:{display:"flex",justifyContent:"center",gap:4},children:[(0,d.jsx)(an,{size:5}),(0,d.jsx)(an,{size:5}),(0,d.jsx)(an,{size:5})]})]})}function qy({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",padding:10,gap:t*.04},children:[(0,d.jsx)(z,{w:e*.4,h:3,strong:!0}),(0,d.jsx)(z,{w:e*.3,h:6,strong:!0}),(0,d.jsx)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:4,width:"100%",padding:"8px 0"},children:Array.from({length:4},(n,o)=>(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:4},children:[(0,d.jsx)(an,{size:5}),(0,d.jsx)(z,{w:`${50+o*17%35}%`,h:2})]},o))}),(0,d.jsx)(lt,{w:e*.7,h:Math.min(32,t*.1),radius:6,style:{background:"var(--agd-bar)"}})]})}function Zy({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",padding:10,gap:8},children:[(0,d.jsx)("span",{style:{fontSize:18,lineHeight:1,color:"var(--agd-stroke)",fontFamily:"serif"},children:"\u201C"}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:4},children:[(0,d.jsx)(z,{w:"90%",h:2}),(0,d.jsx)(z,{w:"75%",h:2}),(0,d.jsx)(z,{w:"60%",h:2})]}),(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:6},children:[(0,d.jsx)(an,{size:20}),(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:2},children:[(0,d.jsx)(z,{w:60,h:3,strong:!0}),(0,d.jsx)(z,{w:40,h:2})]})]})]})}function Jy({width:e,height:t}){return(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100%",gap:t*.08},children:[(0,d.jsx)(z,{w:e*.5,h:Math.max(4,t*.05),strong:!0}),(0,d.jsx)(z,{w:e*.35}),(0,d.jsx)(lt,{w:Math.min(140,e*.25),h:Math.min(32,t*.15),radius:6,style:{marginTop:t*.04,background:"var(--agd-bar)"}})]})}function e5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:6,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",padding:"0 10px",gap:8},children:[(0,d.jsx)("div",{style:{width:16,height:16,borderRadius:"50%",border:"1.5px solid var(--agd-bar-strong)",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0},children:(0,d.jsx)("div",{style:{width:2,height:6,background:"var(--agd-bar-strong)",borderRadius:1}})}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:"40%",h:3,strong:!0}),(0,d.jsx)(z,{w:"70%",h:2})]})]})}function t5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",background:"var(--agd-fill)",display:"flex",alignItems:"center",justifyContent:"center",gap:8,padding:"0 12px"},children:[(0,d.jsx)(z,{w:e*.4,h:3,strong:!0}),(0,d.jsx)(lt,{w:60,h:Math.min(24,t*.6),radius:4})]})}function n5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:t*.06},children:[(0,d.jsx)(z,{w:e*.5,h:2}),(0,d.jsx)(z,{w:e*.4,h:Math.max(8,t*.18),strong:!0}),(0,d.jsx)(z,{w:e*.3,h:2})]})}function o5({width:e,height:t}){let n=Math.max(3,Math.min(5,Math.floor(e/100))),o=Math.min(12,t*.35);return(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",height:"100%",padding:"0 8px"},children:Array.from({length:n},(r,l)=>(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:0,flex:1},children:[(0,d.jsx)("div",{style:{width:o,height:o,borderRadius:"50%",border:"1.5px solid var(--agd-stroke)",background:l===0?"var(--agd-bar)":"transparent",flexShrink:0}}),l<n-1&&(0,d.jsx)("div",{style:{flex:1,height:1,background:"var(--agd-stroke)",margin:"0 4px"}})]},l))})}function r5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:4,border:"1px solid var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",justifyContent:"center",gap:4,padding:"0 6px"},children:[(0,d.jsx)(z,{w:Math.max(16,e*.5),h:2,strong:!0}),(0,d.jsx)("div",{style:{width:8,height:8,borderRadius:"50%",border:"1px solid var(--agd-stroke)",flexShrink:0}})]})}function l5({width:e,height:t}){let o=Math.min(t*.7,e/7.5);return(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",height:"100%",gap:o*.2},children:Array.from({length:5},(r,l)=>(0,d.jsx)("svg",{width:o,height:o,viewBox:"0 0 16 16",fill:"none",children:(0,d.jsx)("path",{d:"M8 1.5l2 4 4.5.7-3.25 3.1.75 4.5L8 11.4l-4 2.4.75-4.5L1.5 6.2 6 5.5z",stroke:"var(--agd-stroke)",strokeWidth:"0.8",fill:l<3?"var(--agd-bar)":"none"})},l))})}function i5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",position:"relative",borderRadius:4,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",overflow:"hidden"},children:[(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",style:{position:"absolute",inset:0},children:[(0,d.jsx)("line",{x1:0,y1:t*.3,x2:e,y2:t*.7,stroke:"var(--agd-stroke)",strokeWidth:"0.5",opacity:".2"}),(0,d.jsx)("line",{x1:0,y1:t*.6,x2:e,y2:t*.2,stroke:"var(--agd-stroke)",strokeWidth:"0.5",opacity:".15"}),(0,d.jsx)("line",{x1:e*.4,y1:0,x2:e*.6,y2:t,stroke:"var(--agd-stroke)",strokeWidth:"0.5",opacity:".15"})]}),(0,d.jsx)("div",{style:{position:"absolute",left:"50%",top:"40%",transform:"translate(-50%, -100%)"},children:(0,d.jsxs)("svg",{width:"16",height:"22",viewBox:"0 0 16 22",fill:"none",children:[(0,d.jsx)("path",{d:"M8 0C3.6 0 0 3.6 0 8c0 6 8 14 8 14s8-8 8-14c0-4.4-3.6-8-8-8z",fill:"var(--agd-bar)",opacity:".4"}),(0,d.jsx)("circle",{cx:"8",cy:"8",r:"3",fill:"var(--agd-fill)"})]})})]})}function s5({width:e,height:t}){let n=Math.max(3,Math.min(5,Math.floor(t/60)));return(0,d.jsxs)("div",{style:{display:"flex",height:"100%",padding:"8px 0"},children:[(0,d.jsx)("div",{style:{width:16,display:"flex",flexDirection:"column",alignItems:"center"},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",flex:1},children:[(0,d.jsx)(an,{size:8}),r<n-1&&(0,d.jsx)("div",{style:{flex:1,width:1,background:"var(--agd-stroke)"}})]},r))}),(0,d.jsx)("div",{style:{flex:1,display:"flex",flexDirection:"column",justifyContent:"space-around",paddingLeft:8},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:`${35+r*13%25}%`,h:3,strong:!0}),(0,d.jsx)(z,{w:`${50+r*17%30}%`,h:2})]},r))})]})}function a5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:8,border:"2px dashed var(--agd-stroke)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:t*.06},children:[(0,d.jsxs)("svg",{width:"24",height:"24",viewBox:"0 0 24 24",fill:"none",children:[(0,d.jsx)("path",{d:"M12 16V4m0 0l-4 4m4-4l4 4",stroke:"var(--agd-stroke)",strokeWidth:"1.5"}),(0,d.jsx)("path",{d:"M4 17v2a1 1 0 001 1h14a1 1 0 001-1v-2",stroke:"var(--agd-stroke)",strokeWidth:"1.5"})]}),(0,d.jsx)(z,{w:e*.4,h:2}),(0,d.jsx)(z,{w:e*.25,h:2})]})}function c5({width:e,height:t}){let n=Math.max(3,Math.min(8,Math.floor(t/20)));return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:6,background:"var(--agd-fill)",border:"1px solid var(--agd-stroke)",padding:8,display:"flex",flexDirection:"column",gap:4},children:[(0,d.jsxs)("div",{style:{display:"flex",gap:3,marginBottom:4},children:[(0,d.jsx)(an,{size:6}),(0,d.jsx)(an,{size:6}),(0,d.jsx)(an,{size:6})]}),Array.from({length:n},(o,r)=>(0,d.jsx)("div",{style:{display:"flex",gap:6,paddingLeft:r>0&&r<n-1?12:0},children:(0,d.jsx)(z,{w:`${25+r*23%50}%`,h:2,strong:r===0})},r))]})}function d5({width:e,height:t}){let r=Math.min((e-16)/7,(t-40)/6);return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"6px 8px"},children:[(0,d.jsx)("span",{style:{fontSize:8,color:"var(--agd-stroke)"},children:"\u2039"}),(0,d.jsx)(z,{w:e*.3,h:3,strong:!0}),(0,d.jsx)("span",{style:{fontSize:8,color:"var(--agd-stroke)"},children:"\u203A"})]}),(0,d.jsxs)("div",{style:{display:"grid",gridTemplateColumns:"repeat(7, 1fr)",gap:2,padding:"0 4px",flex:1},children:[Array.from({length:7},(l,i)=>(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",height:r*.6},children:(0,d.jsx)(z,{w:r*.5,h:2})},`h${i}`)),Array.from({length:35},(l,i)=>(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",height:r},children:(0,d.jsx)("div",{style:{width:r*.6,height:r*.6,borderRadius:"50%",background:i===12?"var(--agd-bar)":"transparent",display:"flex",alignItems:"center",justifyContent:"center"},children:(0,d.jsx)("div",{style:{width:2,height:2,borderRadius:1,background:"var(--agd-bar-strong)",opacity:i===12?1:.3}})})},i))]})]})}function u5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",borderRadius:8,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",padding:"0 10px",gap:8},children:[(0,d.jsx)(an,{size:Math.min(32,t*.55)}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:"50%",h:3,strong:!0}),(0,d.jsx)(z,{w:"75%",h:2})]}),(0,d.jsx)(z,{w:30,h:2})]})}function _5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column"},children:[(0,d.jsx)("div",{style:{height:"50%",background:"var(--agd-fill)",borderBottom:"1px dashed var(--agd-stroke)"}}),(0,d.jsxs)("div",{style:{flex:1,padding:10,display:"flex",flexDirection:"column",gap:5},children:[(0,d.jsx)(z,{w:"65%",h:4,strong:!0}),(0,d.jsx)(z,{w:"40%",h:3}),(0,d.jsx)("div",{style:{flex:1}}),(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between"},children:[(0,d.jsx)(z,{w:"30%",h:5,strong:!0}),(0,d.jsx)(lt,{w:Math.min(70,e*.3),h:26,radius:4,style:{background:"var(--agd-bar)"}})]})]})]})}function f5({width:e,height:t}){let n=Math.min(48,t*.3);return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:t*.06},children:[(0,d.jsx)(an,{size:n}),(0,d.jsx)(z,{w:e*.45,h:4,strong:!0}),(0,d.jsx)(z,{w:e*.3,h:2}),(0,d.jsxs)("div",{style:{display:"flex",gap:e*.08,marginTop:t*.04},children:[(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:2},children:[(0,d.jsx)(z,{w:20,h:3,strong:!0}),(0,d.jsx)(z,{w:28,h:2})]}),(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:2},children:[(0,d.jsx)(z,{w:20,h:3,strong:!0}),(0,d.jsx)(z,{w:28,h:2})]}),(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:2},children:[(0,d.jsx)(z,{w:20,h:3,strong:!0}),(0,d.jsx)(z,{w:28,h:2})]})]})]})}function h5({width:e,height:t}){let n=Math.max(e*.6,80),o=Math.max(3,Math.floor(t/40));return(0,d.jsxs)("div",{style:{height:"100%",display:"flex"},children:[(0,d.jsx)("div",{style:{width:e-n,background:"var(--agd-fill)",opacity:.3}}),(0,d.jsxs)("div",{style:{flex:1,borderLeft:"1px solid var(--agd-stroke)",display:"flex",flexDirection:"column",padding:e*.04},children:[(0,d.jsxs)("div",{style:{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:t*.06},children:[(0,d.jsx)(z,{w:n*.4,h:4,strong:!0}),(0,d.jsx)("div",{style:{width:12,height:12,border:"1px solid var(--agd-stroke)",borderRadius:3}})]}),Array.from({length:o},(r,l)=>(0,d.jsx)("div",{style:{padding:"6px 0"},children:(0,d.jsx)(z,{w:`${50+l*17%35}%`,h:2,strong:l===0})},l))]})]})}function p5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center"},children:[(0,d.jsxs)("div",{style:{flex:1,width:"100%",borderRadius:8,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",padding:10,display:"flex",flexDirection:"column",gap:5},children:[(0,d.jsx)(z,{w:"70%",h:3,strong:!0}),(0,d.jsx)(z,{w:"90%",h:2}),(0,d.jsx)(z,{w:"60%",h:2})]}),(0,d.jsx)("div",{style:{width:10,height:10,background:"var(--agd-fill)",border:"1px dashed var(--agd-stroke)",borderTop:"none",borderLeft:"none",transform:"rotate(45deg)",marginTop:-6}})]})}function m5({width:e,height:t}){let n=Math.min(t*.7,e*.3);return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",alignItems:"center",gap:e*.08},children:[(0,d.jsx)(lt,{w:n,h:n,radius:n*.25}),(0,d.jsx)(z,{w:e*.45,h:Math.max(4,t*.2),strong:!0})]})}function g5({width:e,height:t}){let n=Math.max(2,Math.min(5,Math.floor(t/56)));return(0,d.jsx)("div",{style:{display:"flex",flexDirection:"column",height:"100%"},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{borderBottom:"1px solid var(--agd-stroke)",padding:"8px 6px",display:"flex",alignItems:"center",justifyContent:"space-between",flex:r===0?2:1},children:[(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",gap:6},children:[(0,d.jsx)("span",{style:{fontSize:9,fontWeight:700,color:"var(--agd-stroke)"},children:"Q"}),(0,d.jsx)(z,{w:e*(.3+r*13%25/100),h:3,strong:!0})]}),(0,d.jsx)("span",{style:{fontSize:8,color:"var(--agd-stroke)"},children:r===0?"\u25BC":"\u25B6"})]},r))})}function y5({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(e/120))),o=Math.max(1,Math.min(3,Math.floor(t/120)));return(0,d.jsx)("div",{style:{display:"grid",gridTemplateColumns:`repeat(${n}, 1fr)`,gridTemplateRows:`repeat(${o}, 1fr)`,gap:4,height:"100%"},children:Array.from({length:n*o},(r,l)=>(0,d.jsx)("div",{style:{borderRadius:4,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",position:"relative",overflow:"hidden"},children:(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:"0 0 100 100",preserveAspectRatio:"none",fill:"none",children:[(0,d.jsx)("line",{x1:"0",y1:"0",x2:"100",y2:"100",stroke:"var(--agd-stroke)",strokeWidth:"0.5"}),(0,d.jsx)("line",{x1:"100",y1:"0",x2:"0",y2:"100",stroke:"var(--agd-stroke)",strokeWidth:"0.5"})]})},l))})}function x5({width:e,height:t}){let n=Math.min(e,t);return(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:[(0,d.jsx)("rect",{x:"1",y:(t-n+2)/2,width:n-2,height:n-2,rx:n*.15,stroke:"var(--agd-stroke)",strokeWidth:"1.5"}),(0,d.jsx)("path",{d:`M${n*.25} ${t/2}l${n*.2} ${n*.2} ${n*.3}-${n*.35}`,stroke:"var(--agd-bar)",strokeWidth:"1.5",fill:"none",strokeLinecap:"round",strokeLinejoin:"round"})]})}function v5({width:e,height:t}){let n=Math.min(e,t)/2-1;return(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:[(0,d.jsx)("circle",{cx:e/2,cy:t/2,r:n,stroke:"var(--agd-stroke)",strokeWidth:"1.5"}),(0,d.jsx)("circle",{cx:e/2,cy:t/2,r:n*.45,fill:"var(--agd-bar)"})]})}function w5({width:e,height:t}){let n=Math.max(2,t*.12),o=Math.min(t*.35,10),r=e*.55;return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",alignItems:"center",position:"relative"},children:[(0,d.jsx)("div",{style:{width:"100%",height:n,borderRadius:n/2,background:"var(--agd-fill)",border:"1px solid var(--agd-stroke)",position:"relative"},children:(0,d.jsx)("div",{style:{width:r,height:"100%",borderRadius:n/2,background:"var(--agd-bar)"}})}),(0,d.jsx)("div",{style:{position:"absolute",left:r-o,width:o*2,height:o*2,borderRadius:"50%",border:"1.5px solid var(--agd-stroke)",background:"var(--agd-fill)"}})]})}function b5({width:e,height:t}){let n=Math.min(36,t*.15),o=7,r=4,l=Math.min((e-16)/o,(t-n-40)/(r+1));return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",gap:4},children:[(0,d.jsxs)("div",{style:{height:n,borderRadius:4,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",padding:"0 8px",justifyContent:"space-between"},children:[(0,d.jsx)(z,{w:"40%",h:2}),(0,d.jsxs)("svg",{width:"12",height:"12",viewBox:"0 0 16 16",fill:"none",children:[(0,d.jsx)("rect",{x:"2",y:"3",width:"12",height:"11",rx:"1",stroke:"var(--agd-stroke)",strokeWidth:"1"}),(0,d.jsx)("line",{x1:"2",y1:"6",x2:"14",y2:"6",stroke:"var(--agd-stroke)",strokeWidth:"0.5"})]})]}),(0,d.jsxs)("div",{style:{flex:1,borderRadius:6,border:"1px dashed var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",flexDirection:"column"},children:[(0,d.jsxs)("div",{style:{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 6px"},children:[(0,d.jsx)("span",{style:{fontSize:7,color:"var(--agd-stroke)"},children:"\u2039"}),(0,d.jsx)(z,{w:e*.25,h:2,strong:!0}),(0,d.jsx)("span",{style:{fontSize:7,color:"var(--agd-stroke)"},children:"\u203A"})]}),(0,d.jsx)("div",{style:{display:"grid",gridTemplateColumns:`repeat(${o}, 1fr)`,gap:1,padding:"0 4px",flex:1},children:Array.from({length:o*r},(i,s)=>(0,d.jsx)("div",{style:{display:"flex",alignItems:"center",justifyContent:"center",height:l},children:(0,d.jsx)("div",{style:{width:l*.5,height:l*.5,borderRadius:"50%",background:s===10?"var(--agd-bar)":"transparent"},children:(0,d.jsx)("div",{style:{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center"},children:(0,d.jsx)("div",{style:{width:1.5,height:1.5,borderRadius:1,background:"var(--agd-bar-strong)",opacity:s===10?1:.25}})})})},s))})]})]})}function k5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",gap:t*.08,padding:4},children:[(0,d.jsx)("div",{style:{width:"100%",height:t*.2,borderRadius:4,background:"var(--agd-fill)"}}),(0,d.jsx)("div",{style:{width:"70%",height:Math.max(6,t*.1),borderRadius:3,background:"var(--agd-fill)"}}),(0,d.jsx)("div",{style:{width:"90%",height:Math.max(4,t*.06),borderRadius:3,background:"var(--agd-fill)"}}),(0,d.jsx)("div",{style:{width:"50%",height:Math.max(4,t*.06),borderRadius:3,background:"var(--agd-fill)"}})]})}function C5({width:e,height:t}){return(0,d.jsx)("div",{style:{height:"100%",display:"flex",alignItems:"center",gap:6},children:(0,d.jsxs)("div",{style:{height:"100%",flex:1,borderRadius:t/2,border:"1px solid var(--agd-stroke)",background:"var(--agd-fill)",display:"flex",alignItems:"center",padding:`0 ${t*.3}px`,gap:4},children:[(0,d.jsx)(z,{w:"60%",h:2,strong:!0}),(0,d.jsx)("div",{style:{width:Math.max(6,t*.3),height:Math.max(6,t*.3),borderRadius:"50%",border:"1px solid var(--agd-stroke)",flexShrink:0,marginLeft:"auto"}})]})})}function S5({width:e,height:t}){let n=Math.min(e,t);return(0,d.jsx)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:(0,d.jsx)("path",{d:`M${e/2} ${(t-n)/2+n*.1}l${n*.12} ${n*.25} ${n*.28} ${n*.04}-${n*.2} ${n*.2} ${n*.05} ${n*.28}-${n*.25}-${n*.12}-${n*.25} ${n*.12} ${n*.05}-${n*.28}-${n*.2}-${n*.2} ${n*.28}-${n*.04}z`,stroke:"var(--agd-stroke)",strokeWidth:"1",fill:"var(--agd-fill)"})})}function M5({width:e,height:t}){let n=Math.min(e,t)/2-2;return(0,d.jsxs)("svg",{width:"100%",height:"100%",viewBox:`0 0 ${e} ${t}`,fill:"none",children:[(0,d.jsx)("circle",{cx:e/2,cy:t/2,r:n,stroke:"var(--agd-stroke)",strokeWidth:"1.5",opacity:".2"}),(0,d.jsx)("path",{d:`M${e/2} ${t/2-n}a${n} ${n} 0 0 1 ${n} ${n}`,stroke:"var(--agd-bar-strong)",strokeWidth:"1.5",strokeLinecap:"round"})]})}function E5({width:e,height:t}){let n=Math.min(36,t*.25,e*.12),o=Math.max(1,Math.min(3,Math.floor(t/80)));return(0,d.jsx)("div",{style:{display:"flex",flexDirection:"column",height:"100%",justifyContent:"space-around",padding:8},children:Array.from({length:o},(r,l)=>(0,d.jsxs)("div",{style:{display:"flex",gap:e*.04,alignItems:"flex-start"},children:[(0,d.jsx)(lt,{w:n,h:n,radius:n*.25}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:4},children:[(0,d.jsx)(z,{w:`${40+l*13%20}%`,h:3,strong:!0}),(0,d.jsx)(z,{w:`${60+l*17%25}%`,h:2})]})]},l))})}function L5({width:e,height:t}){let n=Math.max(2,Math.min(4,Math.floor(e/120))),o=Math.min(36,t*.25);return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",gap:t*.06,padding:t*.06},children:[(0,d.jsx)(z,{w:e*.3,h:4,strong:!0}),(0,d.jsx)("div",{style:{display:"flex",gap:e*.06,justifyContent:"center",flex:1,alignItems:"center"},children:Array.from({length:n},(r,l)=>(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",alignItems:"center",gap:6},children:[(0,d.jsx)(an,{size:o}),(0,d.jsx)(z,{w:e*.12,h:3,strong:!0}),(0,d.jsx)(z,{w:e*.08,h:2})]},l))})]})}function I5({width:e,height:t}){let n=Math.max(2,Math.min(3,Math.floor(t/80)));return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",alignItems:"center",padding:e*.06,gap:t*.04},children:[(0,d.jsx)(z,{w:e*.5,h:Math.max(5,t*.04),strong:!0}),(0,d.jsx)(z,{w:e*.35,h:2}),(0,d.jsx)("div",{style:{width:"100%",display:"flex",flexDirection:"column",gap:t*.03,marginTop:t*.04},children:Array.from({length:n},(o,r)=>(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:Math.min(60,e*.2),h:2}),(0,d.jsx)(lt,{w:"100%",h:Math.min(32,t*.1),radius:4})]},r))}),(0,d.jsx)(lt,{w:"100%",h:Math.min(36,t*.12),radius:6,style:{marginTop:t*.03,background:"var(--agd-bar)"}}),(0,d.jsx)(z,{w:e*.4,h:2})]})}function N5({width:e,height:t}){return(0,d.jsxs)("div",{style:{height:"100%",display:"flex",flexDirection:"column",padding:e*.04,gap:t*.03},children:[(0,d.jsx)(z,{w:e*.4,h:4,strong:!0}),(0,d.jsx)(z,{w:e*.6,h:2}),(0,d.jsxs)("div",{style:{display:"flex",gap:6,marginTop:t*.03},children:[(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:50,h:2}),(0,d.jsx)(lt,{w:"100%",h:Math.min(28,t*.1),radius:4})]}),(0,d.jsxs)("div",{style:{flex:1,display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:40,h:2}),(0,d.jsx)(lt,{w:"100%",h:Math.min(28,t*.1),radius:4})]})]}),(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:3},children:[(0,d.jsx)(z,{w:50,h:2}),(0,d.jsx)(lt,{w:"100%",h:Math.min(28,t*.1),radius:4})]}),(0,d.jsxs)("div",{style:{display:"flex",flexDirection:"column",gap:3,flex:1},children:[(0,d.jsx)(z,{w:60,h:2}),(0,d.jsx)(lt,{w:"100%",h:"100%",radius:4})]}),(0,d.jsx)(lt,{w:Math.min(120,e*.3),h:Math.min(30,t*.1),radius:6,style:{alignSelf:"flex-end",background:"var(--agd-bar)"}})]})}var $5={navigation:xy,hero:vy,sidebar:wy,footer:by,modal:ky,card:Cy,text:Sy,image:My,table:Ey,list:Ly,button:Iy,input:Ny,form:$y,tabs:Ry,avatar:Ty,badge:Py,header:Dy,section:By,grid:zy,dropdown:Oy,toggle:Ay,search:Wy,toast:Fy,progress:jy,chart:Hy,video:Uy,tooltip:Yy,breadcrumb:Xy,pagination:Qy,divider:Vy,accordion:Ky,carousel:Gy,pricing:qy,testimonial:Zy,cta:Jy,alert:e5,banner:t5,stat:n5,stepper:o5,tag:r5,rating:l5,map:i5,timeline:s5,fileUpload:a5,codeBlock:c5,calendar:d5,notification:u5,productCard:_5,profile:f5,drawer:h5,popover:p5,logo:m5,faq:g5,gallery:y5,checkbox:x5,radio:v5,slider:w5,datePicker:b5,skeleton:k5,chip:C5,icon:S5,spinner:M5,feature:E5,team:L5,login:I5,contact:N5};function R5({type:e,width:t,height:n,text:o}){let r=$5[e];return r?(0,d.jsx)("div",{style:{width:"100%",height:"100%",padding:8,position:"relative",pointerEvents:"none"},children:(0,d.jsx)(r,{width:t,height:n,text:o})}):(0,d.jsx)("div",{style:{width:"100%",height:"100%",display:"flex",alignItems:"center",justifyContent:"center"},children:(0,d.jsx)("span",{style:{fontSize:10,fontWeight:600,color:"var(--agd-text-3)",textTransform:"uppercase",letterSpacing:"0.06em",opacity:.5},children:e})})}var T5=`svg[fill=none] {
  fill: none !important;
}

.styles-module__overlayExiting___iEmYr {
  opacity: 0 !important;
  transition: opacity 0.25s ease !important;
  pointer-events: none !important;
}

.styles-module__overlay___aWh-q {
  position: fixed;
  inset: 0;
  z-index: 99995;
  pointer-events: auto;
  cursor: default;
  animation: styles-module__overlayFadeIn___aECVy 0.15s ease;
  --agd-stroke: rgba(59, 130, 246, 0.35);
  --agd-fill: rgba(59, 130, 246, 0.06);
  --agd-bar: rgba(59, 130, 246, 0.18);
  --agd-bar-strong: rgba(59, 130, 246, 0.28);
  --agd-text-3: rgba(255, 255, 255, 0.6);
  --agd-surface: #fff;
}
.styles-module__overlay___aWh-q.styles-module__light___ORIft {
  --agd-surface: #fff;
}
.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) {
  --agd-surface: #141414;
}
.styles-module__overlay___aWh-q.styles-module__wireframe___itvQU {
  --agd-stroke: rgba(249, 115, 22, 0.35);
  --agd-fill: rgba(249, 115, 22, 0.06);
  --agd-bar: rgba(249, 115, 22, 0.18);
  --agd-bar-strong: rgba(249, 115, 22, 0.28);
}
.styles-module__overlay___aWh-q.styles-module__placing___45yD8 {
  cursor: crosshair;
}
.styles-module__overlay___aWh-q.styles-module__passthrough___xaFeE {
  pointer-events: none;
}

.styles-module__blankCanvas___t2Eue {
  position: fixed;
  inset: 0;
  z-index: 99994;
  background: #fff;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
}
.styles-module__blankCanvas___t2Eue.styles-module__visible___OKKqX {
  opacity: var(--canvas-opacity, 1);
  pointer-events: auto;
}
.styles-module__blankCanvas___t2Eue::after {
  content: "";
  position: absolute;
  inset: 0;
  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.08) 1px, transparent 1px);
  background-size: 24px 24px;
  background-position: 12px 12px;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.styles-module__blankCanvas___t2Eue.styles-module__gridActive___OZ-cf::after {
  opacity: 1;
  background-image: radial-gradient(circle, rgba(0, 0, 0, 0.22) 1px, transparent 1px);
}

.styles-module__paletteHeader___-Q5gQ {
  padding: 0 1rem 0.375rem;
}

.styles-module__paletteHeaderTitle___oHqZC {
  font-size: 0.8125rem;
  font-weight: 500;
  color: #fff;
  letter-spacing: -0.0094em;
}
.styles-module__light___ORIft .styles-module__paletteHeaderTitle___oHqZC {
  color: rgba(0, 0, 0, 0.85);
}

.styles-module__paletteHeaderDesc___6i74T {
  font-size: 0.6875rem;
  font-weight: 300;
  color: rgba(255, 255, 255, 0.45);
  margin-top: 2px;
  line-height: 14px;
}
.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T {
  color: rgba(0, 0, 0, 0.45);
}
.styles-module__paletteHeaderDesc___6i74T a {
  color: rgba(255, 255, 255, 0.8);
  text-decoration: underline dotted;
  text-decoration-color: rgba(255, 255, 255, 0.2);
  text-underline-offset: 2px;
  transition: color 0.15s ease;
}
.styles-module__paletteHeaderDesc___6i74T a:hover {
  color: #fff;
}
.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T a {
  color: rgba(0, 0, 0, 0.6);
  text-decoration-color: rgba(0, 0, 0, 0.2);
}
.styles-module__light___ORIft .styles-module__paletteHeaderDesc___6i74T a:hover {
  color: rgba(0, 0, 0, 0.85);
}

.styles-module__wireframePurposeWrap___To-tS {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.2s ease, opacity 0.15s ease;
  opacity: 1;
}
.styles-module__wireframePurposeWrap___To-tS.styles-module__collapsed___Ms9vS {
  grid-template-rows: 0fr;
  opacity: 0;
}

.styles-module__wireframePurposeInner___Lrahs {
  overflow: hidden;
}

.styles-module__wireframePurposeInput___7EtBN {
  display: block;
  width: calc(100% - 2rem);
  margin: 0.25rem 1rem 0.375rem;
  padding: 0.375rem 0.5rem;
  font-size: 0.8125rem;
  font-family: inherit;
  color: rgba(255, 255, 255, 0.85);
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 0.375rem;
  resize: none;
  outline: none;
  transition: border-color 0.15s ease;
  letter-spacing: -0.0094em;
}
.styles-module__wireframePurposeInput___7EtBN::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
.styles-module__wireframePurposeInput___7EtBN:focus {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.05);
}
.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN {
  color: rgba(0, 0, 0, 0.7);
  background: rgba(0, 0, 0, 0.03);
  border-color: rgba(0, 0, 0, 0.1);
}
.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN::placeholder {
  color: rgba(0, 0, 0, 0.3);
}
.styles-module__light___ORIft .styles-module__wireframePurposeInput___7EtBN:focus {
  border-color: rgba(0, 0, 0, 0.25);
  background: rgba(0, 0, 0, 0.05);
}

.styles-module__canvasToggle___-QqSy {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  margin: 0.25rem 1rem 0.25rem;
  padding: 0.375rem 0.5rem;
  border-radius: 0.5rem;
  cursor: pointer;
  border: 1px dashed rgba(255, 255, 255, 0.1);
  background: transparent;
  transition: background 0.15s ease, border-color 0.15s ease;
}
.styles-module__canvasToggle___-QqSy:hover {
  background: rgba(255, 255, 255, 0.04);
  border-color: rgba(255, 255, 255, 0.15);
}
.styles-module__canvasToggle___-QqSy.styles-module__active___hosp7 {
  background: #f97316;
  border-color: transparent;
  border-style: solid;
  box-shadow: none;
}
.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy {
  border-color: rgba(0, 0, 0, 0.08);
}
.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy:hover {
  background: rgba(0, 0, 0, 0.02);
  border-color: rgba(0, 0, 0, 0.12);
}
.styles-module__light___ORIft .styles-module__canvasToggle___-QqSy.styles-module__active___hosp7 {
  background: #f97316;
  border-color: transparent;
  border-style: solid;
  box-shadow: none;
}

.styles-module__canvasToggleIcon___7pJ82 {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: rgba(255, 255, 255, 0.35);
}
.styles-module__active___hosp7 .styles-module__canvasToggleIcon___7pJ82 {
  color: rgba(255, 255, 255, 0.85);
}
.styles-module__light___ORIft .styles-module__canvasToggleIcon___7pJ82 {
  color: rgba(0, 0, 0, 0.25);
}
.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__canvasToggleIcon___7pJ82 {
  color: rgba(255, 255, 255, 0.85);
}

.styles-module__canvasToggleLabel___OanpY {
  font-size: 0.8125rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.6);
  letter-spacing: -0.0094em;
}
.styles-module__active___hosp7 .styles-module__canvasToggleLabel___OanpY {
  color: #fff;
}
.styles-module__light___ORIft .styles-module__canvasToggleLabel___OanpY {
  color: rgba(0, 0, 0, 0.5);
}
.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__canvasToggleLabel___OanpY {
  color: #fff;
}

.styles-module__canvasPurposeWrap___hj6zk {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.2s ease, opacity 0.15s ease;
  opacity: 1;
}
.styles-module__canvasPurposeWrap___hj6zk.styles-module__collapsed___Ms9vS {
  grid-template-rows: 0fr;
  opacity: 0;
}

.styles-module__canvasPurposeInner___VWiyu {
  overflow: hidden;
}

.styles-module__canvasPurposeToggle___byDH2 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  margin: 0.375rem 1rem 0.375rem 1.1875rem;
}
.styles-module__canvasPurposeToggle___byDH2 input[type=checkbox] {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.styles-module__canvasPurposeCheck___xqd7l {
  position: relative;
  width: 14px;
  height: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background 0.25s ease, border-color 0.25s ease;
}
.styles-module__canvasPurposeCheck___xqd7l svg {
  color: #1a1a1a;
  opacity: 1;
  transition: opacity 0.15s ease;
}
.styles-module__canvasPurposeCheck___xqd7l.styles-module__checked___-1JGH {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgb(255, 255, 255);
}
.styles-module__light___ORIft .styles-module__canvasPurposeCheck___xqd7l {
  border: 1px solid rgba(0, 0, 0, 0.15);
  background: #fff;
}
.styles-module__light___ORIft .styles-module__canvasPurposeCheck___xqd7l.styles-module__checked___-1JGH {
  border-color: #1a1a1a;
  background: #1a1a1a;
}
.styles-module__light___ORIft .styles-module__canvasPurposeCheck___xqd7l.styles-module__checked___-1JGH svg {
  color: #fff;
}

.styles-module__canvasPurposeLabel___Zu-tD {
  font-size: 0.8125rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: -0.0094em;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
.styles-module__light___ORIft .styles-module__canvasPurposeLabel___Zu-tD {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__canvasPurposeHelp___jijwR {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: help;
}
.styles-module__canvasPurposeHelp___jijwR svg {
  color: rgba(255, 255, 255, 0.2);
  transform: translateY(2px);
  transition: color 0.15s ease;
}
.styles-module__canvasPurposeHelp___jijwR:hover svg {
  color: rgba(255, 255, 255, 0.5);
}
.styles-module__light___ORIft .styles-module__canvasPurposeHelp___jijwR svg {
  color: rgba(0, 0, 0, 0.2);
}
.styles-module__light___ORIft .styles-module__canvasPurposeHelp___jijwR:hover svg {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__placement___zcxv8 {
  position: absolute;
  border: 1.5px dashed rgba(59, 130, 246, 0.4);
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.08);
  cursor: grab;
  transition: box-shadow 0.15s, border-color 0.15s, opacity 0.15s ease, transform 0.15s ease;
  user-select: none;
  pointer-events: auto;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08);
  animation: styles-module__placementEnter___TdRhf 0.25s cubic-bezier(0.34, 1.2, 0.64, 1);
}
.styles-module__placement___zcxv8:active {
  cursor: grabbing;
}
.styles-module__placement___zcxv8:hover {
  border-color: rgba(59, 130, 246, 0.5);
  background: rgba(59, 130, 246, 0.1);
  box-shadow: 0 2px 8px rgba(59, 130, 246, 0.12);
}
.styles-module__placement___zcxv8.styles-module__selected___6yrp6 {
  border-color: #3c82f7;
  border-style: solid;
  background: rgba(59, 130, 246, 0.1);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);
}
.styles-module__placement___zcxv8.styles-module__selected___6yrp6:hover {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);
}
.styles-module__wireframe___itvQU .styles-module__placement___zcxv8 {
  border-color: rgba(249, 115, 22, 0.4);
  background: rgba(249, 115, 22, 0.08);
}
.styles-module__wireframe___itvQU .styles-module__placement___zcxv8:hover {
  border-color: rgba(249, 115, 22, 0.5);
  background: rgba(249, 115, 22, 0.1);
  box-shadow: 0 2px 8px rgba(249, 115, 22, 0.12);
}
.styles-module__wireframe___itvQU .styles-module__placement___zcxv8.styles-module__selected___6yrp6 {
  border-color: #f97316;
  background: rgba(249, 115, 22, 0.1);
  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15), 0 2px 8px rgba(249, 115, 22, 0.15);
}
.styles-module__wireframe___itvQU .styles-module__placement___zcxv8.styles-module__selected___6yrp6:hover {
  box-shadow: 0 0 0 2px rgba(249, 115, 22, 0.15), 0 2px 8px rgba(249, 115, 22, 0.15);
}
.styles-module__placement___zcxv8.styles-module__dragging___le6KZ {
  opacity: 0.85;
  z-index: 50;
}
.styles-module__placement___zcxv8.styles-module__exiting___YrM8F {
  opacity: 0;
  transform: scale(0.97);
  pointer-events: none;
  animation: none;
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);
}

.styles-module__placementContent___f64A4 {
  width: 100%;
  height: 100%;
  overflow: hidden;
  pointer-events: none;
}

.styles-module__placementLabel___0KvWl {
  position: absolute;
  top: -18px;
  left: 0;
  font-size: 10px;
  font-weight: 600;
  color: rgba(59, 130, 246, 0.7);
  white-space: nowrap;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.8), 0 0 8px rgba(255, 255, 255, 0.5);
}
.styles-module__selected___6yrp6 .styles-module__placementLabel___0KvWl {
  color: #3c82f7;
}
.styles-module__wireframe___itvQU .styles-module__placementLabel___0KvWl {
  color: rgba(249, 115, 22, 0.7);
}
.styles-module__wireframe___itvQU .styles-module__selected___6yrp6 .styles-module__placementLabel___0KvWl {
  color: #f97316;
}

.styles-module__placementAnnotation___78pTr {
  position: absolute;
  bottom: -18px;
  left: 0;
  right: 0;
  font-weight: 450;
  color: rgba(0, 0, 0, 0.5);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 255, 255, 0.6);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.styles-module__placementAnnotation___78pTr.styles-module__annotationVisible___mrUyA {
  opacity: 1;
  transform: translateY(0);
}

.styles-module__sectionAnnotation___aUIs0 {
  position: absolute;
  bottom: -18px;
  left: 0;
  right: 0;
  font-weight: 450;
  color: rgba(59, 130, 246, 0.6);
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-shadow: 0 0 4px rgba(255, 255, 255, 0.9), 0 0 8px rgba(255, 255, 255, 0.6);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.styles-module__sectionAnnotation___aUIs0.styles-module__annotationVisible___mrUyA {
  opacity: 1;
  transform: translateY(0);
}

.styles-module__handle___Ikbxm {
  position: absolute;
  width: 8px;
  height: 8px;
  background: #fff;
  border: 1.5px solid #3c82f7;
  border-radius: 2px;
  z-index: 12;
  box-shadow: 0 0 0 0.5px rgba(0, 0, 0, 0.1), 0 1px 2px rgba(0, 0, 0, 0.12);
  opacity: 0;
  transform: scale(0.3);
  pointer-events: none;
  will-change: opacity, transform;
  transition: opacity 0.2s ease-out, transform 0.25s cubic-bezier(0.34, 1.56, 0.64, 1);
}
.styles-module__placement___zcxv8:hover .styles-module__handle___Ikbxm, .styles-module__sectionOutline___s0hy-:hover .styles-module__handle___Ikbxm, .styles-module__ghostOutline___po-kO:hover .styles-module__handle___Ikbxm, .styles-module__placement___zcxv8:active .styles-module__handle___Ikbxm, .styles-module__sectionOutline___s0hy-:active .styles-module__handle___Ikbxm, .styles-module__ghostOutline___po-kO:active .styles-module__handle___Ikbxm, .styles-module__selected___6yrp6 .styles-module__handle___Ikbxm {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}
.styles-module__sectionOutline___s0hy- .styles-module__handle___Ikbxm {
  border-color: inherit;
}
.styles-module__wireframe___itvQU .styles-module__handle___Ikbxm {
  border-color: #f97316;
}

.styles-module__handleNw___4TMIj {
  top: -4px;
  left: -4px;
  cursor: nw-resize;
}

.styles-module__handleNe___mnsTh {
  top: -4px;
  right: -4px;
  cursor: ne-resize;
}

.styles-module__handleSe___oSFnk {
  bottom: -4px;
  right: -4px;
  cursor: se-resize;
}

.styles-module__handleSw___pi--Z {
  bottom: -4px;
  left: -4px;
  cursor: sw-resize;
}

.styles-module__handleN___aBA-Q, .styles-module__handleE___0hM5u, .styles-module__handleS___JjDRv, .styles-module__handleW___ERWGQ {
  opacity: 0 !important;
  pointer-events: none !important;
}

.styles-module__edgeHandle___XxXdT {
  position: absolute;
  z-index: 11;
  display: flex;
  align-items: center;
  justify-content: center;
}
.styles-module__edgeHandle___XxXdT::after {
  content: "";
  position: absolute;
  border-radius: 4px;
  background: #3c82f7;
}
.styles-module__wireframe___itvQU .styles-module__edgeHandle___XxXdT::after {
  background: #f97316;
}
.styles-module__edgeHandle___XxXdT::after {
  opacity: 0;
  transition: opacity 0.1s ease, transform 0.1s ease;
  transform: scale(0.8);
}
.styles-module__edgeHandle___XxXdT:hover::after {
  opacity: 0.85;
  transform: scale(1);
}
.styles-module__edgeHandle___XxXdT svg {
  position: relative;
  z-index: 1;
  opacity: 0;
  transition: opacity 0.1s ease;
  filter: drop-shadow(0 0 2px var(--agd-surface));
}
.styles-module__edgeHandle___XxXdT:hover svg {
  opacity: 1;
}

.styles-module__edgeN___-JJDj, .styles-module__edgeS___66lMX {
  left: 12px;
  right: 12px;
  height: 12px;
  cursor: n-resize;
}
.styles-module__edgeN___-JJDj::after, .styles-module__edgeS___66lMX::after {
  width: 24px;
  height: 4px;
}

.styles-module__edgeN___-JJDj {
  top: -6px;
}

.styles-module__edgeS___66lMX {
  bottom: -6px;
  cursor: s-resize;
}

.styles-module__edgeE___1bGDa, .styles-module__edgeW___lHQNo {
  top: 12px;
  bottom: 12px;
  width: 12px;
  cursor: e-resize;
}
.styles-module__edgeE___1bGDa::after, .styles-module__edgeW___lHQNo::after {
  width: 4px;
  height: 24px;
}

.styles-module__edgeE___1bGDa {
  right: -6px;
}

.styles-module__edgeW___lHQNo {
  left: -6px;
  cursor: w-resize;
}

.styles-module__deleteButton___LkGCb {
  position: absolute;
  top: -8px;
  right: -8px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.9);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
  color: rgba(0, 0, 0, 0.35);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  line-height: 1;
  z-index: 15;
  pointer-events: none;
  opacity: 0;
  transform: scale(0.8);
  will-change: opacity, transform;
  transition: opacity 0.2s ease-out, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), background 0.12s ease, color 0.12s ease, border-color 0.12s ease, box-shadow 0.12s ease;
}
.styles-module__placement___zcxv8:hover .styles-module__deleteButton___LkGCb, .styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb, .styles-module__sectionOutline___s0hy-:hover .styles-module__deleteButton___LkGCb, .styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb, .styles-module__ghostOutline___po-kO:hover .styles-module__deleteButton___LkGCb, .styles-module__ghostOutline___po-kO.styles-module__selected___6yrp6 .styles-module__deleteButton___LkGCb {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}
.styles-module__deleteButton___LkGCb:hover {
  background: #ef4444;
  color: #fff;
  border-color: #ef4444;
  box-shadow: 0 1px 4px rgba(239, 68, 68, 0.3);
  transform: scale(1.1);
}
.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb, .styles-module__rearrangeOverlay___-3R3t:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb {
  background: rgba(40, 40, 40, 0.9);
  border-color: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.5);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.styles-module__overlay___aWh-q:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb:hover, .styles-module__rearrangeOverlay___-3R3t:not(.styles-module__light___ORIft) .styles-module__deleteButton___LkGCb:hover {
  background: #ef4444;
  color: #fff;
  border-color: #ef4444;
}

.styles-module__drawBox___BrVAa {
  position: fixed;
  pointer-events: none;
  z-index: 99996;
  border: 2px solid #3c82f7;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.15);
}

.styles-module__selectBox___Iu8kB {
  position: fixed;
  pointer-events: none;
  z-index: 99996;
  border: 1px dashed #3c82f7;
  background: rgba(59, 130, 246, 0.08);
  border-radius: 2px;
}

.styles-module__sizeIndicator___7zJ4y {
  position: fixed;
  pointer-events: none;
  z-index: 100001;
  font-size: 10px;
  color: #fff;
  background: #3c82f7;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  font-weight: 500;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
}

.styles-module__guideLine___DUQY2 {
  pointer-events: none;
  z-index: 100001;
  background: #f0f;
  opacity: 0.5;
}

.styles-module__dragPreview___onPbU {
  position: fixed;
  z-index: 100002;
  pointer-events: none;
  border: 1.5px dashed #3c82f7;
  border-radius: 6px;
  background: rgba(59, 130, 246, 0.1);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  font-weight: 600;
  color: #3c82f7;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  box-shadow: 0 4px 16px rgba(59, 130, 246, 0.15);
  transition: width 0.08s ease, height 0.08s ease, opacity 0.08s ease;
}

.styles-module__dragPreviewWireframe___jsg0G {
  border-color: #f97316;
  background: rgba(249, 115, 22, 0.1);
  color: #f97316;
  box-shadow: 0 4px 16px rgba(249, 115, 22, 0.15);
}

.styles-module__palette___C7iSH {
  position: absolute;
  right: 5px;
  bottom: calc(100% + 0.5rem);
  width: 256px;
  overflow: hidden;
  background: #1c1c1c;
  border: none;
  border-radius: 1rem;
  padding: 13px 0 16px;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);
  z-index: 100001;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  cursor: default;
  opacity: 0;
  filter: blur(5px);
}
.styles-module__palette___C7iSH .styles-module__paletteItem___6TlnA,
.styles-module__palette___C7iSH .styles-module__paletteItemLabel___6ncO4,
.styles-module__palette___C7iSH .styles-module__paletteSectionTitle___PqnjX,
.styles-module__palette___C7iSH .styles-module__paletteFooter___QYnAG {
  transition: background 0.25s ease, color 0.25s ease, border-color 0.25s ease;
}
.styles-module__palette___C7iSH.styles-module__enter___6LYk5 {
  opacity: 1;
  transform: translateY(0);
  filter: blur(0px);
  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;
}
.styles-module__palette___C7iSH.styles-module__exit___iSGRw {
  opacity: 0;
  transform: translateY(6px);
  filter: blur(5px);
  pointer-events: none;
  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;
}
.styles-module__palette___C7iSH.styles-module__light___ORIft {
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);
}

.styles-module__paletteSection___V8DEA {
  padding: 0 1rem;
}
.styles-module__paletteSection___V8DEA + .styles-module__paletteSection___V8DEA {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.styles-module__light___ORIft .styles-module__paletteSection___V8DEA + .styles-module__paletteSection___V8DEA {
  border-top-color: rgba(0, 0, 0, 0.07);
}

.styles-module__paletteSectionTitle___PqnjX {
  font-size: 0.6875rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: -0.0094em;
  padding: 0 0 3px 3px;
}
.styles-module__light___ORIft .styles-module__paletteSectionTitle___PqnjX {
  color: rgba(0, 0, 0, 0.4);
}

.styles-module__paletteItem___6TlnA {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.25rem 0.25rem;
  margin-bottom: 1px;
  border-radius: 0.375rem;
  cursor: pointer;
  transition: background-color 0.15s ease, border-color 0.15s ease;
  border: 1px solid transparent;
  user-select: none;
  min-height: 24px;
}
.styles-module__paletteItem___6TlnA:hover {
  background: rgba(255, 255, 255, 0.1);
}
.styles-module__paletteItem___6TlnA.styles-module__active___hosp7 {
  background: #3c82f7;
  border-color: transparent;
}
.styles-module__paletteItem___6TlnA.styles-module__wireframe___itvQU.styles-module__active___hosp7 {
  background: #f97316;
}
.styles-module__light___ORIft .styles-module__paletteItem___6TlnA:hover {
  background: rgba(0, 0, 0, 0.05);
}
.styles-module__light___ORIft .styles-module__paletteItem___6TlnA.styles-module__active___hosp7 {
  background: #3c82f7;
  border-color: transparent;
}
.styles-module__light___ORIft .styles-module__paletteItem___6TlnA.styles-module__wireframe___itvQU.styles-module__active___hosp7 {
  background: #f97316;
}

.styles-module__paletteItemIcon___0NPQK {
  width: 20px;
  height: 16px;
  border-radius: 2px;
  border: 1px dashed rgba(255, 255, 255, 0.15);
  background: rgba(255, 255, 255, 0.04);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  overflow: hidden;
  color: rgba(255, 255, 255, 0.45);
}
.styles-module__paletteItemIcon___0NPQK svg {
  display: block;
  width: 20px;
  height: 16px;
}
.styles-module__active___hosp7 .styles-module__paletteItemIcon___0NPQK {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
.styles-module__light___ORIft .styles-module__paletteItemIcon___0NPQK {
  border-color: rgba(0, 0, 0, 0.12);
  background: rgba(0, 0, 0, 0.02);
  color: rgba(0, 0, 0, 0.4);
}
.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__paletteItemIcon___0NPQK {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.styles-module__paletteItemLabel___6ncO4 {
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  letter-spacing: -0.0094em;
  line-height: 1;
  min-width: 0;
}
.styles-module__active___hosp7 .styles-module__paletteItemLabel___6ncO4 {
  color: #fff;
  font-weight: 600;
}
.styles-module__light___ORIft .styles-module__paletteItemLabel___6ncO4 {
  color: rgba(0, 0, 0, 0.7);
}
.styles-module__light___ORIft .styles-module__active___hosp7 .styles-module__paletteItemLabel___6ncO4 {
  color: #fff;
  font-weight: 600;
}

.styles-module__placeScroll___7sClM {
  max-height: 240px;
  overflow-y: auto;
  overflow-x: hidden;
  padding-top: 0.25rem;
}
.styles-module__placeScroll___7sClM.styles-module__fadeTop___KT9tF {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 32px);
  mask-image: linear-gradient(to bottom, transparent 0, black 32px);
}
.styles-module__placeScroll___7sClM.styles-module__fadeBottom___x3ShT {
  -webkit-mask-image: linear-gradient(to bottom, black calc(100% - 32px), transparent 100%);
  mask-image: linear-gradient(to bottom, black calc(100% - 32px), transparent 100%);
}
.styles-module__placeScroll___7sClM.styles-module__fadeTop___KT9tF.styles-module__fadeBottom___x3ShT {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%);
  mask-image: linear-gradient(to bottom, transparent 0, black 32px, black calc(100% - 32px), transparent 100%);
}
.styles-module__placeScroll___7sClM::-webkit-scrollbar {
  width: 3px;
}
.styles-module__placeScroll___7sClM::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.12);
  border-radius: 2px;
}
.styles-module__light___ORIft .styles-module__placeScroll___7sClM::-webkit-scrollbar-thumb {
  background: rgba(0, 0, 0, 0.1);
}

.styles-module__paletteFooterWrap___71-fI {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 0.25s cubic-bezier(0.32, 0.72, 0, 1);
}
.styles-module__paletteFooterWrap___71-fI.styles-module__footerHidden___fJUik {
  grid-template-rows: 0fr;
}

.styles-module__paletteFooterInnerContent___VC26h {
  opacity: 1;
  transform: translateY(0);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.styles-module__footerHidden___fJUik .styles-module__paletteFooterInnerContent___VC26h {
  opacity: 0;
  transform: translateY(4px);
}

.styles-module__paletteFooterInner___dfylY {
  overflow: hidden;
}

.styles-module__paletteFooter___QYnAG {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
  padding: 0 1rem;
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.styles-module__light___ORIft .styles-module__paletteFooter___QYnAG {
  border-top-color: rgba(0, 0, 0, 0.07);
}

.styles-module__paletteFooterCount___D3Fia {
  font-size: 0.8125rem;
  font-weight: 400;
  letter-spacing: -0.0094em;
  color: rgba(255, 255, 255, 0.5);
}
.styles-module__light___ORIft .styles-module__paletteFooterCount___D3Fia {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__paletteFooterClear___ybBoa {
  font-size: 0.8125rem;
  font-weight: 400;
  letter-spacing: -0.0094em;
  color: rgba(255, 255, 255, 0.5);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
  font-family: inherit;
  transition: color 0.15s ease;
}
.styles-module__paletteFooterClear___ybBoa:hover {
  color: rgba(255, 255, 255, 0.7);
}
.styles-module__light___ORIft .styles-module__paletteFooterClear___ybBoa {
  color: rgba(0, 0, 0, 0.5);
}
.styles-module__light___ORIft .styles-module__paletteFooterClear___ybBoa:hover {
  color: rgba(0, 0, 0, 0.6);
}

.styles-module__paletteFooterActions___fLzv8 {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.styles-module__rollingWrap___S75jM {
  display: inline-block;
  overflow: hidden;
  height: 1.15em;
  position: relative;
  vertical-align: bottom;
}

.styles-module__rollingNum___1RKDx {
  position: absolute;
  left: 0;
  top: 0;
}

.styles-module__exitUp___AFDRW {
  animation: styles-module__numExitUp___FRQqx 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;
}

.styles-module__enterUp___CPlXb {
  animation: styles-module__numEnterUp___2Yd-w 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;
}

.styles-module__exitDown___-1yAy {
  animation: styles-module__numExitDown___xm5by 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;
}

.styles-module__enterDown___DDuFR {
  animation: styles-module__numEnterDown___hpxBk 0.25s cubic-bezier(0.32, 0.72, 0, 1) forwards;
}

@keyframes styles-module__numExitUp___FRQqx {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(-110%);
    opacity: 0;
  }
}
@keyframes styles-module__numEnterUp___2Yd-w {
  from {
    transform: translateY(110%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
@keyframes styles-module__numExitDown___xm5by {
  from {
    transform: translateY(0);
    opacity: 1;
  }
  to {
    transform: translateY(110%);
    opacity: 0;
  }
}
@keyframes styles-module__numEnterDown___hpxBk {
  from {
    transform: translateY(-110%);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
.styles-module__rearrangeOverlay___-3R3t {
  position: fixed;
  inset: 0;
  z-index: 99995;
  pointer-events: none;
  cursor: default;
  user-select: none;
  animation: styles-module__overlayFadeIn___aECVy 0.15s ease;
}

.styles-module__hoverHighlight___8eT-v {
  position: fixed;
  pointer-events: none;
  z-index: 99994;
  border: 2px dashed rgba(59, 130, 246, 0.5);
  border-radius: 4px;
  background: rgba(59, 130, 246, 0.06);
  animation: styles-module__highlightFadeIn___Lg7KY 0.12s ease;
}

.styles-module__sectionOutline___s0hy- {
  position: fixed;
  border: 2px solid;
  border-radius: 4px;
  cursor: grab;
}
.styles-module__sectionOutline___s0hy-:active {
  cursor: grabbing;
}
.styles-module__sectionOutline___s0hy- {
  transition: box-shadow 0.15s, border-color 0.3s, background-color 0.3s, border-style 0s;
  user-select: none;
  pointer-events: auto;
  animation: styles-module__sectionEnter___-8BXT 0.2s ease;
}
.styles-module__sectionOutline___s0hy-:hover {
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1), 0 4px 12px rgba(0, 0, 0, 0.15);
}
.styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6 {
  border-style: solid;
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);
}
.styles-module__sectionOutline___s0hy-.styles-module__selected___6yrp6:hover {
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);
}
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) {
  border: 1.5px dashed rgba(150, 150, 150, 0.35);
  background-color: transparent !important;
  box-shadow: none;
}
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover {
  border-color: rgba(150, 150, 150, 0.6);
  box-shadow: none;
}
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__sectionLabel___F80HQ {
  opacity: 0;
  transition: opacity 0.15s ease;
}
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover .styles-module__sectionLabel___F80HQ {
  opacity: 1;
}
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__movedBadge___s8z-q,
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6) .styles-module__sectionDimensions___RcJSL {
  opacity: 0;
  transition: opacity 0.15s ease;
}
.styles-module__sectionOutline___s0hy-.styles-module__settled___b5U5o:not(.styles-module__selected___6yrp6):hover .styles-module__sectionDimensions___RcJSL {
  opacity: 1;
}
.styles-module__sectionOutline___s0hy-.styles-module__exiting___YrM8F {
  opacity: 0;
  transform: scale(0.97);
  pointer-events: none;
  animation: none;
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);
}

.styles-module__sectionLabel___F80HQ {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 10px;
  font-weight: 600;
  color: #fff;
  padding: 2px 8px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  max-width: calc(100% - 8px);
  overflow: hidden;
  text-overflow: ellipsis;
}

.styles-module__movedBadge___s8z-q {
  position: absolute;
  bottom: 22px;
  right: 4px;
  font-size: 9px;
  font-weight: 700;
  color: #fff;
  background: #22c55e;
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.2);
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 0.15s ease, transform 0.15s ease;
}
.styles-module__movedBadge___s8z-q.styles-module__badgeVisible___npbdS {
  opacity: 1;
  transform: scale(1);
  transition: opacity 0.2s cubic-bezier(0.34, 1.2, 0.64, 1), transform 0.2s cubic-bezier(0.34, 1.2, 0.64, 1);
}

.styles-module__resizedBadge___u51V8 {
  background: #3c82f7;
  bottom: 40px;
}

.styles-module__sectionDimensions___RcJSL {
  position: absolute;
  bottom: 4px;
  right: 4px;
  font-size: 9px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.7);
  background: rgba(0, 0, 0, 0.5);
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
.styles-module__light___ORIft .styles-module__sectionDimensions___RcJSL {
  color: rgba(0, 0, 0, 0.5);
  background: rgba(255, 255, 255, 0.7);
}

.styles-module__wireframeNotice___4GJyB {
  position: fixed;
  bottom: 16px;
  left: 24px;
  z-index: 99995;
  font-size: 9.5px;
  font-weight: 400;
  color: rgba(0, 0, 0, 0.4);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: auto;
  animation: styles-module__overlayFadeIn___aECVy 0.3s ease;
  line-height: 1.5;
  max-width: 280px;
}

.styles-module__wireframeOpacityRow___CJXzi {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.styles-module__wireframeOpacityLabel___afkfT {
  font-size: 9px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.32);
  letter-spacing: 0.02em;
  white-space: nowrap;
  user-select: none;
}

.styles-module__wireframeOpacitySlider___YcoEs {
  -webkit-appearance: none;
  appearance: none;
  width: 56px;
  height: 4px;
  background: rgba(0, 0, 0, 0.08);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s ease;
}
.styles-module__wireframeOpacitySlider___YcoEs:hover {
  background: rgba(0, 0, 0, 0.13);
}
.styles-module__wireframeOpacitySlider___YcoEs::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #f97316;
  cursor: pointer;
  transition: background 0.15s ease;
}
.styles-module__wireframeOpacitySlider___YcoEs::-webkit-slider-thumb:hover {
  background: rgb(224.4209205021, 95.3548117155, 5.7790794979);
}
.styles-module__wireframeOpacitySlider___YcoEs::-moz-range-thumb {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #f97316;
  border: none;
  cursor: pointer;
}
.styles-module__wireframeOpacitySlider___YcoEs::-moz-range-track {
  background: rgba(0, 0, 0, 0.08);
  height: 4px;
  border-radius: 2px;
}

.styles-module__wireframeNoticeTitleRow___PJqyG {
  display: flex;
  align-items: center;
  gap: 0;
  margin-bottom: 2px;
}

.styles-module__wireframeNoticeTitle___okr08 {
  font-weight: 600;
  color: rgba(0, 0, 0, 0.55);
}

.styles-module__wireframeNoticeDivider___PNKQ6 {
  width: 1px;
  height: 8px;
  background: rgba(0, 0, 0, 0.12);
  margin: 0 8px;
  flex-shrink: 0;
}

.styles-module__wireframeStartOver___YFk-I {
  font-size: 9.5px;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.35);
  cursor: pointer;
  background: none;
  border: none;
  padding: 0;
  font-family: inherit;
  text-decoration: none;
  transition: color 0.12s ease;
  white-space: nowrap;
}
.styles-module__wireframeStartOver___YFk-I:hover {
  color: rgba(0, 0, 0, 0.6);
}

.styles-module__ghostOutline___po-kO {
  position: fixed;
  border: 1.5px dashed rgba(59, 130, 246, 0.4);
  border-radius: 4px;
  background: rgba(59, 130, 246, 0.04);
  cursor: grab;
  opacity: 0.5;
  user-select: none;
  pointer-events: auto;
  animation: styles-module__ghostEnter___EC3Mb 0.25s ease;
  transition: box-shadow 0.15s, border-color 0.3s, opacity 0.25s;
}
.styles-module__ghostOutline___po-kO:active {
  cursor: grabbing;
}
.styles-module__ghostOutline___po-kO:hover {
  opacity: 0.7;
  box-shadow: 0 0 0 1px rgba(59, 130, 246, 0.1), 0 4px 12px rgba(0, 0, 0, 0.08);
}
.styles-module__ghostOutline___po-kO.styles-module__selected___6yrp6 {
  opacity: 1;
  border-style: solid;
  border-width: 2px;
  border-color: #3c82f7;
  background: rgba(59, 130, 246, 0.08);
  box-shadow: 0 0 0 2px rgba(59, 130, 246, 0.15), 0 2px 8px rgba(59, 130, 246, 0.15);
}
.styles-module__ghostOutline___po-kO.styles-module__exiting___YrM8F {
  opacity: 0;
  transform: scale(0.97);
  pointer-events: none;
  animation: none;
  transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.32, 0.72, 0, 1);
}

.styles-module__ghostBadge___tsQUK {
  position: absolute;
  bottom: calc(100% + 4px);
  left: -1px;
  font-size: 9px;
  font-weight: 600;
  color: rgba(59, 130, 246, 0.9);
  background: rgba(59, 130, 246, 0.08);
  border: 1px solid rgba(59, 130, 246, 0.2);
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  letter-spacing: 0.02em;
  line-height: 1.2;
  animation: styles-module__badgeSlideIn___typJ7 0.2s ease both;
}

@keyframes styles-module__badgeSlideIn___typJ7 {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.styles-module__ghostBadgeExtra___6CVoD {
  display: inline;
  animation: styles-module__badgeExtraIn___i4W8F 0.2s ease both;
}

@keyframes styles-module__badgeExtraIn___i4W8F {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
.styles-module__originalOutline___Y6DD1 {
  position: fixed;
  border: 1.5px dashed rgba(150, 150, 150, 0.3);
  border-radius: 4px;
  background: transparent;
  pointer-events: none;
  user-select: none;
  animation: styles-module__sectionEnter___-8BXT 0.2s ease;
}

.styles-module__originalLabel___HqI9g {
  position: absolute;
  top: 4px;
  left: 4px;
  font-size: 9px;
  font-weight: 500;
  color: rgba(150, 150, 150, 0.5);
  padding: 1px 6px;
  border-radius: 3px;
  white-space: nowrap;
  pointer-events: none;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: rgba(150, 150, 150, 0.08);
}

.styles-module__connectorSvg___Lovld {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  pointer-events: none;
  z-index: 99996;
}

.styles-module__connectorLine___XeWh- {
  transition: opacity 0.2s ease;
  animation: styles-module__connectorDraw___8sK5I 0.3s ease both;
}

.styles-module__connectorDot___yvf7C {
  transform-box: fill-box;
  transform-origin: center;
  animation: styles-module__connectorDotIn___NwTUq 0.25s cubic-bezier(0.34, 1.56, 0.64, 1) 0.15s both;
}

@keyframes styles-module__connectorDraw___8sK5I {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes styles-module__connectorDotIn___NwTUq {
  from {
    transform: scale(0);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
.styles-module__connectorExiting___2lLOs {
  animation: styles-module__connectorOut___5QoPl 0.2s ease forwards;
}
.styles-module__connectorExiting___2lLOs .styles-module__connectorDot___yvf7C {
  animation: styles-module__connectorDotOut___FEq7e 0.2s ease forwards;
}

@keyframes styles-module__connectorOut___5QoPl {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes styles-module__connectorDotOut___FEq7e {
  from {
    transform: scale(1);
    opacity: 1;
  }
  to {
    transform: scale(0);
    opacity: 0;
  }
}
@keyframes styles-module__placementEnter___TdRhf {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes styles-module__sectionEnter___-8BXT {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes styles-module__highlightFadeIn___Lg7KY {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes styles-module__overlayFadeIn___aECVy {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes styles-module__ghostEnter___EC3Mb {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
  to {
    opacity: 0.6;
    transform: scale(1);
  }
}`,P5={overlayExiting:"styles-module__overlayExiting___iEmYr",overlay:"styles-module__overlay___aWh-q",overlayFadeIn:"styles-module__overlayFadeIn___aECVy",light:"styles-module__light___ORIft",wireframe:"styles-module__wireframe___itvQU",placing:"styles-module__placing___45yD8",passthrough:"styles-module__passthrough___xaFeE",blankCanvas:"styles-module__blankCanvas___t2Eue",visible:"styles-module__visible___OKKqX",gridActive:"styles-module__gridActive___OZ-cf",paletteHeader:"styles-module__paletteHeader___-Q5gQ",paletteHeaderTitle:"styles-module__paletteHeaderTitle___oHqZC",paletteHeaderDesc:"styles-module__paletteHeaderDesc___6i74T",wireframePurposeWrap:"styles-module__wireframePurposeWrap___To-tS",collapsed:"styles-module__collapsed___Ms9vS",wireframePurposeInner:"styles-module__wireframePurposeInner___Lrahs",wireframePurposeInput:"styles-module__wireframePurposeInput___7EtBN",canvasToggle:"styles-module__canvasToggle___-QqSy",active:"styles-module__active___hosp7",canvasToggleIcon:"styles-module__canvasToggleIcon___7pJ82",canvasToggleLabel:"styles-module__canvasToggleLabel___OanpY",canvasPurposeWrap:"styles-module__canvasPurposeWrap___hj6zk",canvasPurposeInner:"styles-module__canvasPurposeInner___VWiyu",canvasPurposeToggle:"styles-module__canvasPurposeToggle___byDH2",canvasPurposeCheck:"styles-module__canvasPurposeCheck___xqd7l",checked:"styles-module__checked___-1JGH",canvasPurposeLabel:"styles-module__canvasPurposeLabel___Zu-tD",canvasPurposeHelp:"styles-module__canvasPurposeHelp___jijwR",placement:"styles-module__placement___zcxv8",placementEnter:"styles-module__placementEnter___TdRhf",selected:"styles-module__selected___6yrp6",dragging:"styles-module__dragging___le6KZ",exiting:"styles-module__exiting___YrM8F",placementContent:"styles-module__placementContent___f64A4",placementLabel:"styles-module__placementLabel___0KvWl",placementAnnotation:"styles-module__placementAnnotation___78pTr",annotationVisible:"styles-module__annotationVisible___mrUyA",sectionAnnotation:"styles-module__sectionAnnotation___aUIs0",handle:"styles-module__handle___Ikbxm",sectionOutline:"styles-module__sectionOutline___s0hy-",ghostOutline:"styles-module__ghostOutline___po-kO",handleNw:"styles-module__handleNw___4TMIj",handleNe:"styles-module__handleNe___mnsTh",handleSe:"styles-module__handleSe___oSFnk",handleSw:"styles-module__handleSw___pi--Z",handleN:"styles-module__handleN___aBA-Q",handleE:"styles-module__handleE___0hM5u",handleS:"styles-module__handleS___JjDRv",handleW:"styles-module__handleW___ERWGQ",edgeHandle:"styles-module__edgeHandle___XxXdT",edgeN:"styles-module__edgeN___-JJDj",edgeS:"styles-module__edgeS___66lMX",edgeE:"styles-module__edgeE___1bGDa",edgeW:"styles-module__edgeW___lHQNo",deleteButton:"styles-module__deleteButton___LkGCb",rearrangeOverlay:"styles-module__rearrangeOverlay___-3R3t",drawBox:"styles-module__drawBox___BrVAa",selectBox:"styles-module__selectBox___Iu8kB",sizeIndicator:"styles-module__sizeIndicator___7zJ4y",guideLine:"styles-module__guideLine___DUQY2",dragPreview:"styles-module__dragPreview___onPbU",dragPreviewWireframe:"styles-module__dragPreviewWireframe___jsg0G",palette:"styles-module__palette___C7iSH",paletteItem:"styles-module__paletteItem___6TlnA",paletteItemLabel:"styles-module__paletteItemLabel___6ncO4",paletteSectionTitle:"styles-module__paletteSectionTitle___PqnjX",paletteFooter:"styles-module__paletteFooter___QYnAG",enter:"styles-module__enter___6LYk5",exit:"styles-module__exit___iSGRw",paletteSection:"styles-module__paletteSection___V8DEA",paletteItemIcon:"styles-module__paletteItemIcon___0NPQK",placeScroll:"styles-module__placeScroll___7sClM",fadeTop:"styles-module__fadeTop___KT9tF",fadeBottom:"styles-module__fadeBottom___x3ShT",paletteFooterWrap:"styles-module__paletteFooterWrap___71-fI",footerHidden:"styles-module__footerHidden___fJUik",paletteFooterInnerContent:"styles-module__paletteFooterInnerContent___VC26h",paletteFooterInner:"styles-module__paletteFooterInner___dfylY",paletteFooterCount:"styles-module__paletteFooterCount___D3Fia",paletteFooterClear:"styles-module__paletteFooterClear___ybBoa",paletteFooterActions:"styles-module__paletteFooterActions___fLzv8",rollingWrap:"styles-module__rollingWrap___S75jM",rollingNum:"styles-module__rollingNum___1RKDx",exitUp:"styles-module__exitUp___AFDRW",numExitUp:"styles-module__numExitUp___FRQqx",enterUp:"styles-module__enterUp___CPlXb",numEnterUp:"styles-module__numEnterUp___2Yd-w",exitDown:"styles-module__exitDown___-1yAy",numExitDown:"styles-module__numExitDown___xm5by",enterDown:"styles-module__enterDown___DDuFR",numEnterDown:"styles-module__numEnterDown___hpxBk",hoverHighlight:"styles-module__hoverHighlight___8eT-v",highlightFadeIn:"styles-module__highlightFadeIn___Lg7KY",sectionEnter:"styles-module__sectionEnter___-8BXT",settled:"styles-module__settled___b5U5o",sectionLabel:"styles-module__sectionLabel___F80HQ",movedBadge:"styles-module__movedBadge___s8z-q",sectionDimensions:"styles-module__sectionDimensions___RcJSL",badgeVisible:"styles-module__badgeVisible___npbdS",resizedBadge:"styles-module__resizedBadge___u51V8",wireframeNotice:"styles-module__wireframeNotice___4GJyB",wireframeOpacityRow:"styles-module__wireframeOpacityRow___CJXzi",wireframeOpacityLabel:"styles-module__wireframeOpacityLabel___afkfT",wireframeOpacitySlider:"styles-module__wireframeOpacitySlider___YcoEs",wireframeNoticeTitleRow:"styles-module__wireframeNoticeTitleRow___PJqyG",wireframeNoticeTitle:"styles-module__wireframeNoticeTitle___okr08",wireframeNoticeDivider:"styles-module__wireframeNoticeDivider___PNKQ6",wireframeStartOver:"styles-module__wireframeStartOver___YFk-I",ghostEnter:"styles-module__ghostEnter___EC3Mb",ghostBadge:"styles-module__ghostBadge___tsQUK",badgeSlideIn:"styles-module__badgeSlideIn___typJ7",ghostBadgeExtra:"styles-module__ghostBadgeExtra___6CVoD",badgeExtraIn:"styles-module__badgeExtraIn___i4W8F",originalOutline:"styles-module__originalOutline___Y6DD1",originalLabel:"styles-module__originalLabel___HqI9g",connectorSvg:"styles-module__connectorSvg___Lovld",connectorLine:"styles-module__connectorLine___XeWh-",connectorDraw:"styles-module__connectorDraw___8sK5I",connectorDot:"styles-module__connectorDot___yvf7C",connectorDotIn:"styles-module__connectorDotIn___NwTUq",connectorExiting:"styles-module__connectorExiting___2lLOs",connectorOut:"styles-module__connectorOut___5QoPl",connectorDotOut:"styles-module__connectorDotOut___FEq7e"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-design-mode-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-design-mode-styles",document.head.appendChild(e)),e.textContent=T5}var T=P5,gl=24,xa=5;function Kh(e,t,n,o,r){let l=1/0,i=1/0,s=e.x,a=e.x+e.width,m=e.x+e.width/2,p=e.y,b=e.y+e.height,y=e.y+e.height/2,$=!o,C=$?[s,a,m]:[...o.left?[s]:[],...o.right?[a]:[]],I=$?[p,b,y]:[...o.top?[p]:[],...o.bottom?[b]:[]],E=[];for(let he of t)n.has(he.id)||E.push(he);r&&E.push(...r);for(let he of E){let Ge=he.x,it=he.x+he.width,Re=he.x+he.width/2,We=he.y,Ee=he.y+he.height,Ke=he.y+he.height/2;for(let X of C)for(let me of[Ge,it,Re]){let Ue=me-X;Math.abs(Ue)<xa&&Math.abs(Ue)<Math.abs(l)&&(l=Ue)}for(let X of I)for(let me of[We,Ee,Ke]){let Ue=me-X;Math.abs(Ue)<xa&&Math.abs(Ue)<Math.abs(i)&&(i=Ue)}}let f=Math.abs(l)<xa?l:0,g=Math.abs(i)<xa?i:0,w=[],N=new Set,H=s+f,V=a+f,D=m+f,G=p+g,ye=b+g,Z=y+g;for(let he of E){let Ge=he.x,it=he.x+he.width,Re=he.x+he.width/2,We=he.y,Ee=he.y+he.height,Ke=he.y+he.height/2;for(let X of[Ge,Re,it])for(let me of[H,D,V])if(Math.abs(me-X)<.5){let Ue=`x:${Math.round(X)}`;N.has(Ue)||(N.add(Ue),w.push({axis:"x",pos:X}))}for(let X of[We,Ke,Ee])for(let me of[G,Z,ye])if(Math.abs(me-X)<.5){let Ue=`y:${Math.round(X)}`;N.has(Ue)||(N.add(Ue),w.push({axis:"y",pos:X}))}}return{dx:f,dy:g,guides:w}}function Gh(){return`dp-${Date.now()}-${Math.random().toString(36).slice(2,7)}`}function D5({placements:e,onChange:t,activeComponent:n,onActiveComponentChange:o,isDarkMode:r,exiting:l,onInteractionChange:i,className:s,passthrough:a,extraSnapRects:m,onSelectionChange:p,deselectSignal:b,onDragMove:y,onDragEnd:$,clearSignal:C,wireframe:I}){let[E,f]=(0,Ve.useState)(new Set),[g,w]=(0,Ve.useState)(null),[N,H]=(0,Ve.useState)(null),[V,D]=(0,Ve.useState)(null),[G,ye]=(0,Ve.useState)([]),[Z,he]=(0,Ve.useState)(null),[Ge,it]=(0,Ve.useState)(!1),Re=(0,Ve.useRef)(!1),[We,Ee]=(0,Ve.useState)(new Set),Ke=(0,Ve.useRef)(new Map),X=(0,Ve.useRef)(null),me=(0,Ve.useRef)(null),Ue=(0,Ve.useRef)(e);Ue.current=e;let Mt=(0,Ve.useRef)(p);Mt.current=p;let cn=(0,Ve.useRef)(y);cn.current=y;let en=(0,Ve.useRef)($);en.current=$;let $o=(0,Ve.useRef)(b);(0,Ve.useEffect)(()=>{b!==$o.current&&($o.current=b,f(new Set))},[b]);let Sn=(0,Ve.useRef)(C);(0,Ve.useEffect)(()=>{if(C!==void 0&&C!==Sn.current){Sn.current=C;let U=new Set(Ue.current.map(ue=>ue.id));U.size>0&&(Ee(U),f(new Set),me.current=null,fe(()=>{t([]),Ee(new Set)},180))}},[C,t]),(0,Ve.useEffect)(()=>{let U=ue=>{let xe=ue.target;if(!(xe.tagName==="INPUT"||xe.tagName==="TEXTAREA"||xe.isContentEditable)){if((ue.key==="Backspace"||ue.key==="Delete")&&E.size>0){ue.preventDefault();let ve=new Set(E);Ee(ve),f(new Set),fe(()=>{t(Ue.current.filter(qe=>!ve.has(qe.id))),Ee(new Set)},180);return}if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(ue.key)&&E.size>0){ue.preventDefault();let ve=ue.shiftKey?20:1,qe=ue.key==="ArrowLeft"?-ve:ue.key==="ArrowRight"?ve:0,et=ue.key==="ArrowUp"?-ve:ue.key==="ArrowDown"?ve:0;t(e.map(Ye=>E.has(Ye.id)?{...Ye,x:Math.max(0,Ye.x+qe),y:Math.max(0,Ye.y+et)}:Ye));return}if(ue.key==="Escape"){n?o(null):E.size>0&&f(new Set);return}}};return document.addEventListener("keydown",U),()=>document.removeEventListener("keydown",U)},[E,n,e,t,o]);let Ro=(0,Ve.useCallback)(U=>{if(U.button!==0||a||U.target.closest(`.${T.placement}`))return;U.preventDefault(),U.stopPropagation();let xe=window.scrollY,$e=U.clientX,ve=U.clientY;if(n){me.current="place",i?.(!0);let qe=!1,et=$e,Ye=ve,ze=S=>{et=S.clientX,Ye=S.clientY;let L=Math.abs(et-$e),B=Math.abs(Ye-ve);if((L>5||B>5)&&(qe=!0),qe){let O=Math.min($e,et),J=Math.min(ve,Ye),le=Math.abs(et-$e),F=Math.abs(Ye-ve);w({x:O,y:J,w:le,h:F}),D({x:S.clientX+12,y:S.clientY+12,text:`${Math.round(le)} \xD7 ${Math.round(F)}`})}},pe=S=>{window.removeEventListener("mousemove",ze),window.removeEventListener("mouseup",pe),w(null),D(null),me.current=null,i?.(!1);let L=ee[n],B,O,J,le;qe?(B=Math.min($e,et),O=Math.min(ve,Ye)+xe,J=Math.max(gl,Math.abs(et-$e)),le=Math.max(gl,Math.abs(Ye-ve))):(J=L.width,le=L.height,B=$e-J/2,O=ve+xe-le/2),B=Math.max(0,B),O=Math.max(0,O);let F={id:Gh(),type:n,x:B,y:O,width:J,height:le,scrollY:xe,timestamp:Date.now()},ie=[...e,F];t(ie),f(new Set([F.id])),o(null)};window.addEventListener("mousemove",ze),window.addEventListener("mouseup",pe)}else{U.shiftKey||f(new Set),me.current="select";let qe=!1,et=ze=>{let pe=Math.abs(ze.clientX-$e),S=Math.abs(ze.clientY-ve);if((pe>4||S>4)&&(qe=!0),qe){let L=Math.min($e,ze.clientX),B=Math.min(ve,ze.clientY);H({x:L,y:B,w:Math.abs(ze.clientX-$e),h:Math.abs(ze.clientY-ve)})}},Ye=ze=>{if(window.removeEventListener("mousemove",et),window.removeEventListener("mouseup",Ye),me.current=null,qe){let pe=Math.min($e,ze.clientX),S=Math.min(ve,ze.clientY)+xe,L=Math.abs(ze.clientX-$e),B=Math.abs(ze.clientY-ve),O=new Set(U.shiftKey?E:new Set);for(let J of e){let le=J.y-xe;J.x+J.width>pe&&J.x<pe+L&&J.y+J.height>S&&J.y<S+B&&O.add(J.id)}f(O)}H(null)};window.addEventListener("mousemove",et),window.addEventListener("mouseup",Ye)}},[n,a,e,t,E]),On=(0,Ve.useCallback)((U,ue)=>{if(U.button!==0)return;let xe=U.target;if(xe.closest(`.${T.handle}`)||xe.closest(`.${T.deleteButton}`))return;U.preventDefault(),U.stopPropagation();let $e;U.shiftKey?($e=new Set(E),$e.has(ue)?$e.delete(ue):$e.add(ue)):E.has(ue)?$e=new Set(E):$e=new Set([ue]),f($e),($e.size!==E.size||[...$e].some(ie=>!E.has(ie)))&&Mt.current?.($e,U.shiftKey);let qe=window.scrollY,et=U.clientX,Ye=U.clientY,ze=new Map;for(let ie of e)$e.has(ie.id)&&ze.set(ie.id,{x:ie.x,y:ie.y});me.current="move",i?.(!0);let pe=!1,S=!1,L=e,B=0,O=0,J=new Map;for(let ie of e)ze.has(ie.id)&&J.set(ie.id,{w:ie.width,h:ie.height});let le=ie=>{let Se=ie.clientX-et,Fe=ie.clientY-Ye;if((Math.abs(Se)>2||Math.abs(Fe)>2)&&(pe=!0),!pe)return;if(ie.altKey&&!S){S=!0;let we=[];for(let ut of e)ze.has(ut.id)&&we.push({...ut,id:Gh(),timestamp:Date.now()});L=[...e,...we]}let Ze=1/0,se=1/0,tt=-1/0,Pe=-1/0;for(let[we,ut]of ze){let Ft=J.get(we);Ft&&(Ze=Math.min(Ze,ut.x+Se),se=Math.min(se,ut.y+Fe),tt=Math.max(tt,ut.x+Se+Ft.w),Pe=Math.max(Pe,ut.y+Fe+Ft.h))}let Le={x:Ze,y:se,width:tt-Ze,height:Pe-se},{dx:ae,dy:nt,guides:je}=Kh(Le,L,new Set(ze.keys()),void 0,m);ye(je);let Ie=Se+ae,Xe=Fe+nt;B=Ie,O=Xe,t(L.map(we=>{let ut=ze.get(we.id);return ut?{...we,x:Math.max(0,ut.x+Ie),y:Math.max(0,ut.y+Xe)}:we})),cn.current?.(Ie,Xe)},F=()=>{window.removeEventListener("mousemove",le),window.removeEventListener("mouseup",F),me.current=null,i?.(!1),ye([]),en.current?.(B,O,pe)};window.addEventListener("mousemove",le),window.addEventListener("mouseup",F)},[E,e,t,i]),mo=(0,Ve.useCallback)((U,ue,xe)=>{U.preventDefault(),U.stopPropagation();let $e=e.find(O=>O.id===ue);if(!$e)return;f(new Set([ue])),me.current="resize",i?.(!0);let ve=U.clientX,qe=U.clientY,et=$e.width,Ye=$e.height,ze=$e.x,pe=$e.y,S={left:xe.includes("w"),right:xe.includes("e"),top:xe.includes("n"),bottom:xe.includes("s")},L=O=>{let J=O.clientX-ve,le=O.clientY-qe,F=et,ie=Ye,Se=ze,Fe=pe;xe.includes("e")&&(F=Math.max(gl,et+J)),xe.includes("w")&&(F=Math.max(gl,et-J),Se=ze+et-F),xe.includes("s")&&(ie=Math.max(gl,Ye+le)),xe.includes("n")&&(ie=Math.max(gl,Ye-le),Fe=pe+Ye-ie);let Ze={x:Se,y:Fe,width:F,height:ie},{dx:se,dy:tt,guides:Pe}=Kh(Ze,Ue.current,new Set([ue]),S,m);ye(Pe),se!==0&&(S.right?F+=se:S.left&&(Se+=se,F-=se)),tt!==0&&(S.bottom?ie+=tt:S.top&&(Fe+=tt,ie-=tt)),t(Ue.current.map(Le=>Le.id===ue?{...Le,x:Se,y:Fe,width:F,height:ie}:Le)),D({x:O.clientX+12,y:O.clientY+12,text:`${Math.round(F)} \xD7 ${Math.round(ie)}`})},B=()=>{window.removeEventListener("mousemove",L),window.removeEventListener("mouseup",B),D(null),me.current=null,i?.(!1),ye([])};window.addEventListener("mousemove",L),window.addEventListener("mouseup",B)},[e,t,i]),To=(0,Ve.useCallback)(U=>{me.current=null,Ee(ue=>{let xe=new Set(ue);return xe.add(U),xe}),f(ue=>{let xe=new Set(ue);return xe.delete(U),xe}),fe(()=>{t(Ue.current.filter(ue=>ue.id!==U)),Ee(ue=>{let xe=new Set(ue);return xe.delete(U),xe})},180)},[t]),rr=new Set(["text","hero","button","badge","cta","toast","modal","card","navigation","tabs","input","search","breadcrumb","pricing","testimonial","alert","banner","tag","notification","stat","productCard"]),gn={hero:"Headline text",button:"Button label",badge:"Badge label",cta:"Call to action text",toast:"Notification message",modal:"Dialog title",card:"Card title",navigation:"Brand / nav items",tabs:"Tab labels",input:"Placeholder text",search:"Search placeholder",pricing:"Plan name or price",testimonial:"Quote text",alert:"Alert message",banner:"Banner text",tag:"Tag label",notification:"Notification message",stat:"Metric value",productCard:"Product name"},An=(0,Ve.useCallback)(U=>{let ue=e.find(xe=>xe.id===U);ue&&(Re.current=!!ue.text,he(U),it(!1))},[e]),dn=(0,Ve.useCallback)(()=>{Z&&(it(!0),fe(()=>{he(null),it(!1)},150))},[Z]);(0,Ve.useEffect)(()=>{l&&Z&&dn()},[l]);let eo=(0,Ve.useCallback)(U=>{Z&&(t(e.map(ue=>ue.id===Z?{...ue,text:U.trim()||void 0}:ue)),dn())},[Z,e,t,dn]),to=typeof window<"u"?window.scrollY:0,Tr=["nw","ne","se","sw"],Wn=I?"#f97316":"#3c82f7",Te=[{dir:"n",cls:T.edgeN,arrow:(0,dt.jsx)("svg",{width:"8",height:"6",viewBox:"0 0 8 6",fill:"none",children:(0,dt.jsx)("path",{d:"M4 0.5L1 4.5h6z",fill:Wn})})},{dir:"e",cls:T.edgeE,arrow:(0,dt.jsx)("svg",{width:"6",height:"8",viewBox:"0 0 6 8",fill:"none",children:(0,dt.jsx)("path",{d:"M5.5 4L1.5 1v6z",fill:Wn})})},{dir:"s",cls:T.edgeS,arrow:(0,dt.jsx)("svg",{width:"8",height:"6",viewBox:"0 0 8 6",fill:"none",children:(0,dt.jsx)("path",{d:"M4 5.5L1 1.5h6z",fill:Wn})})},{dir:"w",cls:T.edgeW,arrow:(0,dt.jsx)("svg",{width:"6",height:"8",viewBox:"0 0 6 8",fill:"none",children:(0,dt.jsx)("path",{d:"M0.5 4L4.5 1v6z",fill:Wn})})}];return(0,dt.jsxs)(dt.Fragment,{children:[(0,dt.jsx)("div",{ref:X,className:`${T.overlay} ${r?"":T.light} ${n?T.placing:""} ${a?T.passthrough:""} ${l?T.overlayExiting:""} ${I?T.wireframe:""}${s?` ${s}`:""}`,"data-feedback-toolbar":!0,onMouseDown:Ro,children:e.map(U=>{let ue=E.has(U.id),xe=Jn[U.type]?.label||U.type,$e=U.y-to;return(0,dt.jsxs)("div",{"data-design-placement":U.id,className:`${T.placement} ${ue?T.selected:""} ${We.has(U.id)?T.exiting:""}`,style:{left:U.x,top:$e,width:U.width,height:U.height,position:"fixed"},onMouseDown:ve=>On(ve,U.id),onDoubleClick:()=>An(U.id),children:[(0,dt.jsx)("span",{className:T.placementLabel,children:xe}),(0,dt.jsx)("span",{className:`${T.placementAnnotation} ${U.text?T.annotationVisible:""}`,children:(U.text&&Ke.current.set(U.id,U.text),U.text||Ke.current.get(U.id)||"")}),(0,dt.jsx)("div",{className:T.placementContent,children:(0,dt.jsx)(R5,{type:U.type,width:U.width,height:U.height,text:U.text})}),(0,dt.jsx)("div",{className:T.deleteButton,onMouseDown:ve=>ve.stopPropagation(),onClick:()=>To(U.id),children:"\u2715"}),Tr.map(ve=>(0,dt.jsx)("div",{className:`${T.handle} ${T[`handle${ve.charAt(0).toUpperCase()}${ve.slice(1)}`]}`,onMouseDown:qe=>mo(qe,U.id,ve)},ve)),Te.map(({dir:ve,cls:qe,arrow:et})=>(0,dt.jsx)("div",{className:`${T.edgeHandle} ${qe}`,onMouseDown:Ye=>mo(Ye,U.id,ve),children:et},ve))]},U.id)})}),Z&&(()=>{let U=e.find(pe=>pe.id===Z);if(!U)return null;let ue=U.y-to,xe=U.x+U.width/2,$e=ue-8,ve=ue+U.height+8,qe=$e>200,et=ve<window.innerHeight-100,Ye=Math.max(160,Math.min(window.innerWidth-160,xe)),ze;return qe?ze={left:Ye,bottom:window.innerHeight-$e}:et?ze={left:Ye,top:ve}:ze={left:Ye,top:Math.max(80,window.innerHeight/2-80)},(0,dt.jsx)($a,{element:Jn[U.type]?.label||U.type,placeholder:gn[U.type]||"Label or content text",initialValue:U.text??"",submitLabel:Re.current?"Save":"Set",onSubmit:eo,onCancel:dn,onDelete:Re.current?()=>{eo("")}:void 0,isExiting:Ge,lightMode:!r,style:ze})})(),g&&(0,dt.jsx)("div",{className:T.drawBox,style:{left:g.x,top:g.y,width:g.w,height:g.h},"data-feedback-toolbar":!0}),N&&(0,dt.jsx)("div",{className:T.selectBox,style:{left:N.x,top:N.y,width:N.w,height:N.h},"data-feedback-toolbar":!0}),V&&(0,dt.jsx)("div",{className:T.sizeIndicator,style:{left:V.x,top:V.y},"data-feedback-toolbar":!0,children:V.text}),G.map((U,ue)=>(0,dt.jsx)("div",{className:T.guideLine,style:U.axis==="x"?{position:"fixed",left:U.pos,top:0,width:1,bottom:0}:{position:"fixed",left:0,top:U.pos-to,right:0,height:1},"data-feedback-toolbar":!0},`${U.axis}-${U.pos}-${ue}`))]})}function B5(e){if(!e)return"";let t=e.scrollTop>2,n=e.scrollTop+e.clientHeight<e.scrollHeight-2;return`${t?T.fadeTop:""} ${n?T.fadeBottom:""}`}var _="currentColor",R="0.5";function z5({type:e}){switch(e){case"navigation":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"4",width:"18",height:"8",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2.5",y:"7",width:"3",height:"1.5",rx:".5",fill:_,opacity:".4"}),(0,c.jsx)("rect",{x:"7",y:"7",width:"2.5",height:"1.5",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"11",y:"7",width:"2.5",height:"1.5",rx:".5",fill:_,opacity:".25"})]});case"header":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"2",width:"18",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3",y:"5.5",width:"8",height:"2",rx:".5",fill:_,opacity:".35"}),(0,c.jsx)("rect",{x:"3",y:"9",width:"12",height:"1",rx:".5",fill:_,opacity:".15"})]});case"hero":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"1",width:"18",height:"14",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5",y:"5",width:"10",height:"1.5",rx:".5",fill:_,opacity:".35"}),(0,c.jsx)("rect",{x:"7",y:"8",width:"6",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"7.5",y:"10.5",width:"5",height:"2.5",rx:"1",stroke:_,strokeWidth:R})]});case"section":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"1",width:"18",height:"14",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3",y:"4",width:"6",height:"1",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"3",y:"6.5",width:"14",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"3",y:"9",width:"10",height:"1",rx:".5",fill:_,opacity:".15"})]});case"sidebar":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"1",width:"7",height:"14",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2.5",y:"4",width:"4",height:"1",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"2.5",y:"6.5",width:"3.5",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"2.5",y:"9",width:"4",height:"1",rx:".5",fill:_,opacity:".15"})]});case"footer":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"7",width:"18",height:"8",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3",y:"9.5",width:"4",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"9",y:"9.5",width:"4",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"15",y:"9.5",width:"3",height:"1",rx:".5",fill:_,opacity:".2"})]});case"modal":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"2",width:"14",height:"12",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5",y:"4.5",width:"7",height:"1",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"5",y:"7",width:"10",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"11",y:"11",width:"5",height:"2",rx:".75",stroke:_,strokeWidth:R})]});case"divider":return(0,c.jsx)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:(0,c.jsx)("line",{x1:"2",y1:"8",x2:"18",y2:"8",stroke:_,strokeWidth:"0.5",opacity:".3"})});case"card":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"1",width:"16",height:"14",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2",y:"1",width:"16",height:"5.5",rx:"1",fill:_,opacity:".04"}),(0,c.jsx)("rect",{x:"4",y:"8.5",width:"8",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"4",y:"11",width:"11",height:"1",rx:".5",fill:_,opacity:".12"})]});case"text":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"4",width:"14",height:"1.5",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"2",y:"7",width:"11",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"2",y:"9.5",width:"13",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"2",y:"12",width:"8",height:"1",rx:".5",fill:_,opacity:".12"})]});case"image":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"16",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("line",{x1:"2",y1:"2",x2:"18",y2:"14",stroke:_,strokeWidth:".3",opacity:".25"}),(0,c.jsx)("line",{x1:"18",y1:"2",x2:"2",y2:"14",stroke:_,strokeWidth:".3",opacity:".25"})]});case"video":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"16",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("path",{d:"M8.5 5.5v5l4.5-2.5z",stroke:_,strokeWidth:R,fill:_,opacity:".15"})]});case"table":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"2",width:"18",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("line",{x1:"1",y1:"5.5",x2:"19",y2:"5.5",stroke:_,strokeWidth:".3",opacity:".25"}),(0,c.jsx)("line",{x1:"1",y1:"9",x2:"19",y2:"9",stroke:_,strokeWidth:".3",opacity:".25"}),(0,c.jsx)("line",{x1:"7",y1:"2",x2:"7",y2:"14",stroke:_,strokeWidth:".3",opacity:".25"}),(0,c.jsx)("line",{x1:"13",y1:"2",x2:"13",y2:"14",stroke:_,strokeWidth:".3",opacity:".25"})]});case"grid":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1.5",y:"2",width:"7",height:"5.5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"11.5",y:"2",width:"7",height:"5.5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"1.5",y:"9.5",width:"7",height:"5.5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"11.5",y:"9.5",width:"7",height:"5.5",rx:"1",stroke:_,strokeWidth:R})]});case"list":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"3.5",cy:"4.5",r:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6.5",y:"4",width:"10",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"3.5",cy:"8",r:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6.5",y:"7.5",width:"8",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"3.5",cy:"11.5",r:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6.5",y:"11",width:"11",height:"1",rx:".5",fill:_,opacity:".2"})]});case"chart":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"9",width:"2.5",height:"4",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("rect",{x:"7",y:"6",width:"2.5",height:"7",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"11",y:"3",width:"2.5",height:"10",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"15",y:"5",width:"2.5",height:"8",rx:".5",fill:_,opacity:".2"})]});case"accordion":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1.5",y:"2",width:"17",height:"4",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3",y:"3.5",width:"6",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"1.5",y:"7.5",width:"17",height:"3",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"1.5",y:"12",width:"17",height:"3",rx:"1",stroke:_,strokeWidth:R})]});case"carousel":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"2",width:"14",height:"10",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("path",{d:"M1.5 7L3 8.5 1.5 10",stroke:_,strokeWidth:R,opacity:".35"}),(0,c.jsx)("path",{d:"M18.5 7L17 8.5 18.5 10",stroke:_,strokeWidth:R,opacity:".35"}),(0,c.jsx)("circle",{cx:"8.5",cy:"14",r:".6",fill:_,opacity:".35"}),(0,c.jsx)("circle",{cx:"10",cy:"14",r:".6",fill:_,opacity:".15"}),(0,c.jsx)("circle",{cx:"11.5",cy:"14",r:".6",fill:_,opacity:".15"})]});case"button":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"5",width:"14",height:"6",rx:"2",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6.5",y:"7.5",width:"7",height:"1",rx:".5",fill:_,opacity:".25"})]});case"input":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"4",width:"5.5",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"2",y:"6.5",width:"16",height:"5.5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3.5",y:"8.5",width:"7",height:"1",rx:".5",fill:_,opacity:".12"})]});case"search":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"4.5",width:"16",height:"7",rx:"3.5",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"6",cy:"8",r:"2",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("line",{x1:"7.5",y1:"9.5",x2:"9",y2:"11",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("rect",{x:"9.5",y:"7.5",width:"6",height:"1",rx:".5",fill:_,opacity:".12"})]});case"form":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"1.5",width:"5.5",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"2",y:"3.5",width:"16",height:"3",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2",y:"8",width:"7",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"2",y:"10",width:"16",height:"3",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"12",y:"14",width:"6",height:"2",rx:".75",stroke:_,strokeWidth:R})]});case"tabs":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"5",width:"18",height:"10",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"1",y:"2",width:"6",height:"3.5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2.5",y:"3.25",width:"3",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"7",y:"2",width:"6",height:"3.5",rx:".75",stroke:_,strokeWidth:R})]});case"dropdown":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"16",height:"4",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3.5",y:"3.5",width:"7",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("path",{d:"M15 3.5l1.5 1.5L18 3.5",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("rect",{x:"2",y:"7",width:"16",height:"7",rx:"1",stroke:_,strokeWidth:R,strokeDasharray:"2 1",opacity:".3"})]});case"toggle":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"4",y:"5",width:"12",height:"6",rx:"3",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"13",cy:"8",r:"2",fill:_,opacity:".3"})]});case"avatar":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"10",cy:"8",r:"6",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"10",cy:"6.5",r:"2",stroke:_,strokeWidth:R}),(0,c.jsx)("path",{d:"M6.5 13c0-2 1.5-3.5 3.5-3.5s3.5 1.5 3.5 3.5",stroke:_,strokeWidth:R})]});case"badge":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"5",width:"14",height:"6",rx:"3",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6",y:"7.5",width:"8",height:"1",rx:".5",fill:_,opacity:".25"})]});case"breadcrumb":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1.5",y:"7",width:"3.5",height:"1",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("path",{d:"M6.5 7l1 1-1 1",stroke:_,strokeWidth:R,opacity:".2"}),(0,c.jsx)("rect",{x:"9",y:"7",width:"3.5",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("path",{d:"M14 7l1 1-1 1",stroke:_,strokeWidth:R,opacity:".2"}),(0,c.jsx)("rect",{x:"16.5",y:"7",width:"2",height:"1",rx:".5",fill:_,opacity:".15"})]});case"pagination":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"5.5",width:"3.5",height:"5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6.5",y:"5.5",width:"3.5",height:"5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"11",y:"5.5",width:"3.5",height:"5",rx:"1",fill:_,opacity:".15",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"15.5",y:"5.5",width:"3.5",height:"5",rx:"1",stroke:_,strokeWidth:R})]});case"progress":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"7",width:"16",height:"2",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2",y:"7",width:"10",height:"2",rx:"1",fill:_,opacity:".2"})]});case"toast":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"4",width:"16",height:"8",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"5",cy:"8",r:"1.5",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("rect",{x:"8",y:"6.5",width:"7",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"8",y:"9",width:"5",height:"1",rx:".5",fill:_,opacity:".12"})]});case"tooltip":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"3",width:"14",height:"7",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5.5",y:"5.5",width:"9",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("path",{d:"M9 10l1 2.5 1-2.5",stroke:_,strokeWidth:R})]});case"pricing":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"1",width:"16",height:"14",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6",y:"3",width:"8",height:"1.5",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"7",y:"5.5",width:"6",height:"2",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"5",y:"9",width:"10",height:"1",rx:".5",fill:_,opacity:".1"}),(0,c.jsx)("rect",{x:"5",y:"11",width:"10",height:"1",rx:".5",fill:_,opacity:".1"}),(0,c.jsx)("rect",{x:"6",y:"13",width:"8",height:"1.5",rx:".5",fill:_,opacity:".2"})]});case"testimonial":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"1",width:"16",height:"14",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("text",{x:"4",y:"5.5",fontSize:"4",fill:_,opacity:".2",fontFamily:"serif",children:"\u201C"}),(0,c.jsx)("rect",{x:"4",y:"7",width:"12",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"4",y:"9",width:"9",height:"1",rx:".5",fill:_,opacity:".12"}),(0,c.jsx)("circle",{cx:"5.5",cy:"12.5",r:"1.5",stroke:_,strokeWidth:R,opacity:".25"}),(0,c.jsx)("rect",{x:"8",y:"12",width:"5",height:"1",rx:".5",fill:_,opacity:".15"})]});case"cta":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"2",width:"18",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5",y:"4.5",width:"10",height:"1.5",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"6",y:"7.5",width:"8",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"7",y:"10",width:"6",height:"2.5",rx:"1",stroke:_,strokeWidth:R})]});case"alert":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"4",width:"16",height:"8",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"6",cy:"8",r:"2",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("line",{x1:"6",y1:"7",x2:"6",y2:"8.5",stroke:_,strokeWidth:"0.6",opacity:".5"}),(0,c.jsx)("circle",{cx:"6",cy:"9.3",r:".3",fill:_,opacity:".5"}),(0,c.jsx)("rect",{x:"9.5",y:"7",width:"6",height:"1",rx:".5",fill:_,opacity:".2"})]});case"banner":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"5",width:"18",height:"6",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"4",y:"7.5",width:"8",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"14",y:"7",width:"3.5",height:"2",rx:".75",stroke:_,strokeWidth:R})]});case"stat":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"2",width:"14",height:"12",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6",y:"4.5",width:"8",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"5",y:"7",width:"10",height:"2.5",rx:".5",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"7",y:"11",width:"6",height:"1",rx:".5",fill:_,opacity:".12"})]});case"stepper":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"4",cy:"8",r:"2",fill:_,opacity:".2",stroke:_,strokeWidth:R}),(0,c.jsx)("line",{x1:"6",y1:"8",x2:"8",y2:"8",stroke:_,strokeWidth:".4",opacity:".3"}),(0,c.jsx)("circle",{cx:"10",cy:"8",r:"2",stroke:_,strokeWidth:R}),(0,c.jsx)("line",{x1:"12",y1:"8",x2:"14",y2:"8",stroke:_,strokeWidth:".4",opacity:".3"}),(0,c.jsx)("circle",{cx:"16",cy:"8",r:"2",stroke:_,strokeWidth:R})]});case"tag":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"5",width:"14",height:"6",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5.5",y:"7.5",width:"6",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("line",{x1:"14",y1:"6.5",x2:"15.5",y2:"9.5",stroke:_,strokeWidth:R,opacity:".2"}),(0,c.jsx)("line",{x1:"15.5",y1:"6.5",x2:"14",y2:"9.5",stroke:_,strokeWidth:R,opacity:".2"})]});case"rating":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("path",{d:"M4 5.5l1 2 2.2.3-1.6 1.5.4 2.2L4 10.3l-2 1.2.4-2.2L.8 7.8 3 7.5z",fill:_,opacity:".25"}),(0,c.jsx)("path",{d:"M10 5.5l1 2 2.2.3-1.6 1.5.4 2.2L10 10.3l-2 1.2.4-2.2L6.8 7.8 9 7.5z",fill:_,opacity:".25"}),(0,c.jsx)("path",{d:"M16 5.5l1 2 2.2.3-1.6 1.5.4 2.2L16 10.3l-2 1.2.4-2.2-1.6-1.5 2.2-.3z",stroke:_,strokeWidth:R,opacity:".25"})]});case"map":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"16",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("line",{x1:"2",y1:"6",x2:"18",y2:"10",stroke:_,strokeWidth:".3",opacity:".15"}),(0,c.jsx)("line",{x1:"7",y1:"2",x2:"11",y2:"14",stroke:_,strokeWidth:".3",opacity:".15"}),(0,c.jsx)("path",{d:"M10 5c-1.7 0-3 1.3-3 3 0 2.5 3 5 3 5s3-2.5 3-5c0-1.7-1.3-3-3-3z",fill:_,opacity:".15",stroke:_,strokeWidth:R})]});case"timeline":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("line",{x1:"5",y1:"2",x2:"5",y2:"14",stroke:_,strokeWidth:".4",opacity:".25"}),(0,c.jsx)("circle",{cx:"5",cy:"4",r:"1.5",fill:_,opacity:".2",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"8",y:"3",width:"8",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("circle",{cx:"5",cy:"8.5",r:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"8",y:"7.5",width:"6",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("circle",{cx:"5",cy:"13",r:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"8",y:"12",width:"7",height:"1",rx:".5",fill:_,opacity:".15"})]});case"fileUpload":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"2",width:"14",height:"12",rx:"1.5",stroke:_,strokeWidth:R,strokeDasharray:"2 1"}),(0,c.jsx)("path",{d:"M10 10V5.5m0 0L7.5 8m2.5-2.5L12.5 8",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("rect",{x:"7",y:"11.5",width:"6",height:"1",rx:".5",fill:_,opacity:".15"})]});case"codeBlock":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"16",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"4",cy:"4",r:".6",fill:_,opacity:".3"}),(0,c.jsx)("circle",{cx:"5.5",cy:"4",r:".6",fill:_,opacity:".3"}),(0,c.jsx)("circle",{cx:"7",cy:"4",r:".6",fill:_,opacity:".3"}),(0,c.jsx)("rect",{x:"4",y:"7",width:"7",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("rect",{x:"6",y:"9",width:"5",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"4",y:"11",width:"8",height:"1",rx:".5",fill:_,opacity:".12"})]});case"calendar":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"3",width:"16",height:"12",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("line",{x1:"2",y1:"6.5",x2:"18",y2:"6.5",stroke:_,strokeWidth:".4",opacity:".25"}),(0,c.jsx)("rect",{x:"5",y:"4",width:"1",height:"1.5",rx:".3",fill:_,opacity:".2"}),(0,c.jsx)("rect",{x:"14",y:"4",width:"1",height:"1.5",rx:".3",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"7",cy:"9",r:".6",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"10",cy:"9",r:".6",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"13",cy:"9",r:".6",fill:_,opacity:".3"}),(0,c.jsx)("circle",{cx:"7",cy:"12",r:".6",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"10",cy:"12",r:".6",fill:_,opacity:".2"})]});case"notification":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"3",width:"16",height:"10",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"5.5",cy:"8",r:"2",stroke:_,strokeWidth:R,opacity:".25"}),(0,c.jsx)("rect",{x:"9",y:"6",width:"6",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"9",y:"8.5",width:"4.5",height:"1",rx:".5",fill:_,opacity:".12"}),(0,c.jsx)("circle",{cx:"16.5",cy:"4.5",r:"1.5",fill:_,opacity:".25"})]});case"productCard":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"1",width:"14",height:"14",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3",y:"1",width:"14",height:"6",rx:"1",fill:_,opacity:".04"}),(0,c.jsx)("rect",{x:"5",y:"8.5",width:"7",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"5",y:"10.5",width:"4",height:"1.5",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"12",y:"12",width:"4",height:"2",rx:".75",stroke:_,strokeWidth:R})]});case"profile":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"10",cy:"5",r:"3",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5",y:"10",width:"10",height:"1.5",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"7",y:"12.5",width:"6",height:"1",rx:".5",fill:_,opacity:".12"})]});case"drawer":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"9",y:"1",width:"10",height:"14",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"10.5",y:"4",width:"5",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"10.5",y:"6.5",width:"7",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"10.5",y:"9",width:"6",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"1",y:"1",width:"7",height:"14",rx:"1",stroke:_,strokeWidth:R,opacity:".15"})]});case"popover":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"2",width:"14",height:"9",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5",y:"4.5",width:"8",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"5",y:"7",width:"6",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("path",{d:"M9 11l1 2.5 1-2.5",stroke:_,strokeWidth:R})]});case"logo":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"3",width:"10",height:"10",rx:"2",stroke:_,strokeWidth:R}),(0,c.jsx)("path",{d:"M5 9.5l2-4 2 4",stroke:_,strokeWidth:R,opacity:".3"}),(0,c.jsx)("rect",{x:"14",y:"6",width:"4",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("rect",{x:"14",y:"8.5",width:"3",height:"1",rx:".5",fill:_,opacity:".12"})]});case"faq":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("text",{x:"2.5",y:"5.5",fontSize:"4",fill:_,opacity:".3",fontWeight:"bold",children:"?"}),(0,c.jsx)("rect",{x:"7",y:"3",width:"10",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"7",y:"5.5",width:"8",height:"1",rx:".5",fill:_,opacity:".12"}),(0,c.jsx)("text",{x:"2.5",y:"11.5",fontSize:"4",fill:_,opacity:".3",fontWeight:"bold",children:"?"}),(0,c.jsx)("rect",{x:"7",y:"9",width:"9",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"7",y:"11.5",width:"7",height:"1",rx:".5",fill:_,opacity:".12"})]});case"gallery":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1.5",y:"1.5",width:"5",height:"5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"7.5",y:"1.5",width:"5",height:"5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"13.5",y:"1.5",width:"5",height:"5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"1.5",y:"9.5",width:"5",height:"5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"7.5",y:"9.5",width:"5",height:"5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"13.5",y:"9.5",width:"5",height:"5",rx:".75",stroke:_,strokeWidth:R})]});case"checkbox":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"5",y:"4",width:"8",height:"8",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("path",{d:"M7.5 8l1.5 1.5 3-3",stroke:_,strokeWidth:R,opacity:".35"})]});case"radio":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"10",cy:"8",r:"4",stroke:_,strokeWidth:R}),(0,c.jsx)("circle",{cx:"10",cy:"8",r:"2",fill:_,opacity:".3"})]});case"slider":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"7.5",width:"16",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"2",y:"7.5",width:"10",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("circle",{cx:"12",cy:"8",r:"2.5",stroke:_,strokeWidth:R})]});case"datePicker":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"1",width:"16",height:"5",rx:"1",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"3.5",y:"3",width:"5",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("rect",{x:"14",y:"2.5",width:"2.5",height:"2",rx:".5",fill:_,opacity:".12"}),(0,c.jsx)("rect",{x:"2",y:"7",width:"16",height:"8",rx:"1",stroke:_,strokeWidth:R,strokeDasharray:"2 1",opacity:".3"}),(0,c.jsx)("circle",{cx:"6",cy:"10",r:".6",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"10",cy:"10",r:".6",fill:_,opacity:".3"}),(0,c.jsx)("circle",{cx:"14",cy:"10",r:".6",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"6",cy:"13",r:".6",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"10",cy:"13",r:".6",fill:_,opacity:".2"})]});case"skeleton":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"16",height:"3",rx:"1",fill:_,opacity:".08"}),(0,c.jsx)("rect",{x:"2",y:"7",width:"10",height:"2",rx:".75",fill:_,opacity:".08"}),(0,c.jsx)("rect",{x:"2",y:"11",width:"13",height:"2",rx:".75",fill:_,opacity:".08"})]});case"chip":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"1.5",y:"5",width:"10",height:"6",rx:"3",fill:_,opacity:".08",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"4",y:"7.5",width:"4",height:"1",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("line",{x1:"9.5",y1:"6.5",x2:"10.5",y2:"9.5",stroke:_,strokeWidth:R,opacity:".2"}),(0,c.jsx)("line",{x1:"10.5",y1:"6.5",x2:"9.5",y2:"9.5",stroke:_,strokeWidth:R,opacity:".2"}),(0,c.jsx)("rect",{x:"13",y:"5",width:"5.5",height:"6",rx:"3",stroke:_,strokeWidth:R,opacity:".25"})]});case"icon":return(0,c.jsx)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:(0,c.jsx)("path",{d:"M10 3l1.5 3 3.5.5-2.5 2.5.5 3.5L10 11l-3 1.5.5-3.5L5 6.5l3.5-.5z",stroke:_,strokeWidth:R,opacity:".3"})});case"spinner":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"10",cy:"8",r:"5",stroke:_,strokeWidth:R,opacity:".12"}),(0,c.jsx)("path",{d:"M10 3a5 5 0 0 1 5 5",stroke:_,strokeWidth:R,opacity:".35",strokeLinecap:"round"})]});case"feature":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"2",width:"5",height:"5",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("path",{d:"M4.5 3.5v3m-1.5-1.5h3",stroke:_,strokeWidth:R,opacity:".25"}),(0,c.jsx)("rect",{x:"9",y:"2.5",width:"8",height:"1.5",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"9",y:"5.5",width:"6",height:"1",rx:".5",fill:_,opacity:".12"}),(0,c.jsx)("rect",{x:"2",y:"10",width:"5",height:"5",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"9",y:"10.5",width:"7",height:"1.5",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"9",y:"13.5",width:"5",height:"1",rx:".5",fill:_,opacity:".12"})]});case"team":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("circle",{cx:"5",cy:"5",r:"2.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"2.5",y:"9",width:"5",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"15",cy:"5",r:"2.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"12.5",y:"9",width:"5",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("circle",{cx:"10",cy:"5",r:"2.5",stroke:_,strokeWidth:R,opacity:".5"}),(0,c.jsx)("rect",{x:"7.5",y:"9",width:"5",height:"1",rx:".5",fill:_,opacity:".15"}),(0,c.jsx)("rect",{x:"4",y:"12",width:"12",height:"1",rx:".5",fill:_,opacity:".1"})]});case"login":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"3",y:"1",width:"14",height:"14",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6",y:"3",width:"8",height:"1.5",rx:".5",fill:_,opacity:".25"}),(0,c.jsx)("rect",{x:"5",y:"5.5",width:"10",height:"3",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"5",y:"9.5",width:"10",height:"3",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"6.5",y:"13.5",width:"7",height:"2",rx:".75",fill:_,opacity:".2"})]});case"contact":return(0,c.jsxs)("svg",{viewBox:"0 0 20 16",width:"20",height:"16",fill:"none",children:[(0,c.jsx)("rect",{x:"2",y:"1",width:"16",height:"14",rx:"1.5",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"4",y:"3",width:"5",height:"1",rx:".5",fill:_,opacity:".2"}),(0,c.jsx)("rect",{x:"4",y:"5",width:"12",height:"2.5",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"4",y:"8.5",width:"12",height:"4",rx:".75",stroke:_,strokeWidth:R}),(0,c.jsx)("rect",{x:"11",y:"13.5",width:"5",height:"1.5",rx:".5",fill:_,opacity:".2"})]});default:return null}}function O5({activeType:e,onSelect:t,onDragStart:n,scrollRef:o,fadeClass:r,blankCanvas:l}){return(0,c.jsx)("div",{ref:o,className:`${T.placeScroll} ${r||""}`,children:bp.map(i=>(0,c.jsxs)("div",{className:T.paletteSection,children:[(0,c.jsx)("div",{className:T.paletteSectionTitle,children:i.section}),i.items.map(s=>(0,c.jsxs)("div",{className:`${T.paletteItem} ${e===s.type?T.active:""} ${l?T.wireframe:""}`,onClick:()=>t(s.type),onMouseDown:a=>{a.button===0&&n(s.type,a)},children:[(0,c.jsx)("div",{className:T.paletteItemIcon,children:(0,c.jsx)(z5,{type:s.type})}),(0,c.jsx)("span",{className:T.paletteItemLabel,children:s.label})]},s.type))]},i.section))})}function A5({value:e,suffix:t}){let[n,o]=(0,St.useState)(null),[r,l]=(0,St.useState)(t),[i,s]=(0,St.useState)("up"),a=(0,St.useRef)(e),m=(0,St.useRef)(t),p=(0,St.useRef)(),b=n!==null&&r!==t;return(0,St.useEffect)(()=>{if(e!==a.current){if(e===0){a.current=e,m.current=t,o(null);return}s(e>a.current?"up":"down"),o(a.current),l(m.current),a.current=e,m.current=t,clearTimeout(p.current),p.current=fe(()=>o(null),250)}else m.current=t},[e,t]),n===null?(0,c.jsxs)(c.Fragment,{children:[e,t?` ${t}`:""]}):b?(0,c.jsxs)("span",{className:T.rollingWrap,children:[(0,c.jsxs)("span",{style:{visibility:"hidden"},children:[e," ",t]}),(0,c.jsxs)("span",{className:`${T.rollingNum} ${i==="up"?T.exitUp:T.exitDown}`,children:[n," ",r]},`o${n}-${e}`),(0,c.jsxs)("span",{className:`${T.rollingNum} ${i==="up"?T.enterUp:T.enterDown}`,children:[e," ",t]},`n${e}`)]}):(0,c.jsxs)(c.Fragment,{children:[(0,c.jsxs)("span",{className:T.rollingWrap,children:[(0,c.jsx)("span",{style:{visibility:"hidden"},children:e}),(0,c.jsx)("span",{className:`${T.rollingNum} ${i==="up"?T.exitUp:T.exitDown}`,children:n},`o${n}-${e}`),(0,c.jsx)("span",{className:`${T.rollingNum} ${i==="up"?T.enterUp:T.enterDown}`,children:e},`n${e}`)]}),t?` ${t}`:""]})}function W5({activeType:e,onSelect:t,isDarkMode:n,sectionCount:o,onDetectSections:r,visible:l,onExited:i,placementCount:s,onClearPlacements:a,onDragStart:m,blankCanvas:p,onBlankCanvasChange:b,wireframePurpose:y,onWireframePurposeChange:$,Tooltip:C}){let[I,E]=(0,St.useState)(!1),[f,g]=(0,St.useState)("exit"),[w,N]=(0,St.useState)(!1),[H,V]=(0,St.useState)(!0),D=(0,St.useRef)(0),G=(0,St.useRef)(""),ye=(0,St.useRef)(0),Z=(0,St.useRef)(),he=(0,St.useRef)(null),[Ge,it]=(0,St.useState)("");(0,St.useEffect)(()=>(l?(E(!0),clearTimeout(Z.current),cancelAnimationFrame(ye.current),ye.current=vl(()=>{ye.current=vl(()=>{g("enter")})})):(cancelAnimationFrame(ye.current),g("exit"),clearTimeout(Z.current),Z.current=fe(()=>{E(!1),i?.()},200)),()=>cancelAnimationFrame(ye.current)),[l]);let Re=s>0||o>0,We=s+o;if(We>0&&(D.current=We,G.current=p?We===1?"Component":"Components":We===1?"Change":"Changes"),(0,St.useEffect)(()=>{if(Re)w?V(!1):(V(!0),N(!0),vl(()=>{vl(()=>{V(!1)})}));else{V(!0);let Ke=fe(()=>N(!1),300);return()=>clearTimeout(Ke)}},[Re]),(0,St.useEffect)(()=>{if(!I)return;let Ke=he.current;if(!Ke)return;let X=()=>it(B5(Ke));X(),Ke.addEventListener("scroll",X,{passive:!0});let me=new ResizeObserver(X);return me.observe(Ke),()=>{Ke.removeEventListener("scroll",X),me.disconnect()}},[I]),!I)return null;let Ee=[];return s>0&&Ee.push("placed"),o>0&&Ee.push("captured"),(0,c.jsxs)("div",{className:`${T.palette} ${T[f]} ${n?"":T.light}`,"data-feedback-toolbar":!0,"data-agentation-palette":!0,onClick:Ke=>Ke.stopPropagation(),onMouseDown:Ke=>Ke.stopPropagation(),onTransitionEnd:Ke=>{Ke.target===Ke.currentTarget&&(l||(clearTimeout(Z.current),E(!1),g("exit"),i?.()))},children:[(0,c.jsxs)("div",{className:T.paletteHeader,children:[(0,c.jsx)("div",{className:T.paletteHeaderTitle,children:"Layout Mode"}),(0,c.jsxs)("div",{className:T.paletteHeaderDesc,children:["Rearrange and resize existing elements, add new components, and explore layout ideas. Agent results may vary."," ",(0,c.jsx)("a",{href:"https://agentation.dev/features#layout-mode",target:"_blank",rel:"noopener noreferrer",children:"Learn more."})]})]}),(0,c.jsxs)("div",{className:`${T.canvasToggle} ${p?T.active:""}`,onClick:()=>b(!p),children:[(0,c.jsx)("span",{className:T.canvasToggleIcon,children:(0,c.jsxs)("svg",{viewBox:"0 0 14 14",width:"14",height:"14",fill:"none",children:[(0,c.jsx)("rect",{x:"1",y:"1",width:"12",height:"12",rx:"2",stroke:"currentColor",strokeWidth:"1"}),(0,c.jsx)("circle",{cx:"4.5",cy:"4.5",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"7",cy:"4.5",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"9.5",cy:"4.5",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"4.5",cy:"7",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"7",cy:"7",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"9.5",cy:"7",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"4.5",cy:"9.5",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"7",cy:"9.5",r:"0.8",fill:"currentColor",opacity:".6"}),(0,c.jsx)("circle",{cx:"9.5",cy:"9.5",r:"0.8",fill:"currentColor",opacity:".6"})]})}),(0,c.jsx)("span",{className:T.canvasToggleLabel,children:"Wireframe New Page"})]}),(0,c.jsx)("div",{className:`${T.wireframePurposeWrap} ${p?"":T.collapsed}`,children:(0,c.jsx)("div",{className:T.wireframePurposeInner,children:(0,c.jsx)("textarea",{className:T.wireframePurposeInput,placeholder:"Describe this page to provide additional context for your agent.",value:y,onChange:Ke=>$(Ke.target.value),rows:2})})}),(0,c.jsx)(O5,{activeType:e,onSelect:t,onDragStart:m,scrollRef:he,fadeClass:Ge,blankCanvas:p}),w&&(0,c.jsx)("div",{className:`${T.paletteFooterWrap} ${H?T.footerHidden:""}`,children:(0,c.jsx)("div",{className:T.paletteFooterInner,children:(0,c.jsx)("div",{className:T.paletteFooterInnerContent,children:(0,c.jsxs)("div",{className:T.paletteFooter,children:[(0,c.jsx)("span",{className:T.paletteFooterCount,children:(0,c.jsx)(A5,{value:D.current,suffix:G.current})}),(0,c.jsx)("button",{className:T.paletteFooterClear,onClick:a,children:"Clear"})]})})})})]})}function Cl(e){if(e.parentElement)return e.parentElement;let t=e.getRootNode();return t instanceof ShadowRoot?t.host:null}function sn(e,t){let n=e;for(;n;){if(n.matches(t))return n;n=Cl(n)}return null}function F5(e,t=4){let n=[],o=e,r=0;for(;o&&r<t;){let l=o.tagName.toLowerCase();if(l==="html"||l==="body")break;let i=l;if(o.id)i=`#${o.id}`;else if(o.className&&typeof o.className=="string"){let a=o.className.split(/\s+/).find(m=>m.length>2&&!m.match(/^[a-z]{1,2}$/)&&!m.match(/[A-Z0-9]{5,}/));a&&(i=`.${a.split("_")[0]}`)}let s=Cl(o);!o.parentElement&&s&&(i=`\u27E8shadow\u27E9 ${i}`),n.unshift(i),o=s,r++}return n.join(" > ")}function wl(e){let t=F5(e);if(e.dataset.element)return{name:e.dataset.element,path:t};let n=e.tagName.toLowerCase();if(["path","circle","rect","line","g"].includes(n)){let o=sn(e,"svg");if(o){let r=Cl(o);if(r instanceof HTMLElement)return{name:`graphic in ${wl(r).name}`,path:t}}return{name:"graphic element",path:t}}if(n==="svg"){let o=Cl(e);if(o?.tagName.toLowerCase()==="button"){let r=o.textContent?.trim();return{name:r?`icon in "${r}" button`:"button icon",path:t}}return{name:"icon",path:t}}if(n==="button"){let o=e.textContent?.trim(),r=e.getAttribute("aria-label");return r?{name:`button [${r}]`,path:t}:{name:o?`button "${o.slice(0,25)}"`:"button",path:t}}if(n==="a"){let o=e.textContent?.trim(),r=e.getAttribute("href");return o?{name:`link "${o.slice(0,25)}"`,path:t}:r?{name:`link to ${r.slice(0,30)}`,path:t}:{name:"link",path:t}}if(n==="input"){let o=e.getAttribute("type")||"text",r=e.getAttribute("placeholder"),l=e.getAttribute("name");return r?{name:`input "${r}"`,path:t}:l?{name:`input [${l}]`,path:t}:{name:`${o} input`,path:t}}if(["h1","h2","h3","h4","h5","h6"].includes(n)){let o=e.textContent?.trim();return{name:o?`${n} "${o.slice(0,35)}"`:n,path:t}}if(n==="p"){let o=e.textContent?.trim();return o?{name:`paragraph: "${o.slice(0,40)}${o.length>40?"...":""}"`,path:t}:{name:"paragraph",path:t}}if(n==="span"||n==="label"){let o=e.textContent?.trim();return o&&o.length<40?{name:`"${o}"`,path:t}:{name:n,path:t}}if(n==="li"){let o=e.textContent?.trim();return o&&o.length<40?{name:`list item: "${o.slice(0,35)}"`,path:t}:{name:"list item",path:t}}if(n==="blockquote")return{name:"blockquote",path:t};if(n==="code"){let o=e.textContent?.trim();return o&&o.length<30?{name:`code: \`${o}\``,path:t}:{name:"code",path:t}}if(n==="pre")return{name:"code block",path:t};if(n==="img"){let o=e.getAttribute("alt");return{name:o?`image "${o.slice(0,30)}"`:"image",path:t}}if(n==="video")return{name:"video",path:t};if(["div","section","article","nav","header","footer","aside","main"].includes(n)){let o=e.className,r=e.getAttribute("role"),l=e.getAttribute("aria-label");if(l)return{name:`${n} [${l}]`,path:t};if(r)return{name:`${r}`,path:t};if(typeof o=="string"&&o){let i=o.split(/[\s_-]+/).map(s=>s.replace(/[A-Z0-9]{5,}.*$/,"")).filter(s=>s.length>2&&!/^[a-z]{1,2}$/.test(s)).slice(0,2);if(i.length>0)return{name:i.join(" "),path:t}}return{name:n==="div"?"container":n,path:t}}return{name:n,path:t}}function Li(e){let t=[],n=e.textContent?.trim();n&&n.length<100&&t.push(n);let o=e.previousElementSibling;if(o){let l=o.textContent?.trim();l&&l.length<50&&t.unshift(`[before: "${l.slice(0,40)}"]`)}let r=e.nextElementSibling;if(r){let l=r.textContent?.trim();l&&l.length<50&&t.push(`[after: "${l.slice(0,40)}"]`)}return t.join(" ")}function va(e){let t=Cl(e);if(!t)return"";let r=(e.getRootNode()instanceof ShadowRoot&&e.parentElement?Array.from(e.parentElement.children):Array.from(t.children)).filter(p=>p!==e&&p instanceof HTMLElement);if(r.length===0)return"";let l=r.slice(0,4).map(p=>{let b=p.tagName.toLowerCase(),y=p.className,$="";if(typeof y=="string"&&y){let C=y.split(/\s+/).map(I=>I.replace(/[_][a-zA-Z0-9]{5,}.*$/,"")).find(I=>I.length>2&&!/^[a-z]{1,2}$/.test(I));C&&($=`.${C}`)}if(b==="button"||b==="a"){let C=p.textContent?.trim().slice(0,15);if(C)return`${b}${$} "${C}"`}return`${b}${$}`}),s=t.tagName.toLowerCase();if(typeof t.className=="string"&&t.className){let p=t.className.split(/\s+/).map(b=>b.replace(/[_][a-zA-Z0-9]{5,}.*$/,"")).find(b=>b.length>2&&!/^[a-z]{1,2}$/.test(b));p&&(s=`.${p}`)}let a=t.children.length,m=a>l.length+1?` (${a} total in ${s})`:"";return l.join(", ")+m}function Ii(e){let t=e.className;return typeof t!="string"||!t?"":t.split(/\s+/).filter(o=>o.length>0).map(o=>{let r=o.match(/^([a-zA-Z][a-zA-Z0-9_-]*?)(?:_[a-zA-Z0-9]{5,})?$/);return r?r[1]:o}).filter((o,r,l)=>l.indexOf(o)===r).join(", ")}var kp=new Set(["none","normal","auto","0px","rgba(0, 0, 0, 0)","transparent","static","visible"]),j5=new Set(["p","span","h1","h2","h3","h4","h5","h6","label","li","td","th","blockquote","figcaption","caption","legend","dt","dd","pre","code","em","strong","b","i","a","time","cite","q"]),H5=new Set(["input","textarea","select"]),U5=new Set(["img","video","canvas","svg"]),Y5=new Set(["div","section","article","nav","header","footer","aside","main","ul","ol","form","fieldset"]);function wa(e){if(typeof window>"u")return{};let t=window.getComputedStyle(e),n={},o=e.tagName.toLowerCase(),r;j5.has(o)?r=["color","fontSize","fontWeight","fontFamily","lineHeight"]:o==="button"||o==="a"&&e.getAttribute("role")==="button"?r=["backgroundColor","color","padding","borderRadius","fontSize"]:H5.has(o)?r=["backgroundColor","color","padding","borderRadius","fontSize"]:U5.has(o)?r=["width","height","objectFit","borderRadius"]:Y5.has(o)?r=["display","padding","margin","gap","backgroundColor"]:r=["color","fontSize","margin","padding","backgroundColor"];for(let l of r){let i=l.replace(/([A-Z])/g,"-$1").toLowerCase(),s=t.getPropertyValue(i);s&&!kp.has(s)&&(n[l]=s)}return n}var X5=["color","backgroundColor","borderColor","fontSize","fontWeight","fontFamily","lineHeight","letterSpacing","textAlign","width","height","padding","margin","border","borderRadius","display","position","top","right","bottom","left","zIndex","flexDirection","justifyContent","alignItems","gap","opacity","visibility","overflow","boxShadow","transform"];function ba(e){if(typeof window>"u")return"";let t=window.getComputedStyle(e),n=[];for(let o of X5){let r=o.replace(/([A-Z])/g,"-$1").toLowerCase(),l=t.getPropertyValue(r);l&&!kp.has(l)&&n.push(`${r}: ${l}`)}return n.join("; ")}function Q5(e){if(!e)return;let t={},n=e.split(";").map(o=>o.trim()).filter(Boolean);for(let o of n){let r=o.indexOf(":");if(r>0){let l=o.slice(0,r).trim(),i=o.slice(r+1).trim();l&&i&&(t[l]=i)}}return Object.keys(t).length>0?t:void 0}function ka(e){let t=[],n=e.getAttribute("role"),o=e.getAttribute("aria-label"),r=e.getAttribute("aria-describedby"),l=e.getAttribute("tabindex"),i=e.getAttribute("aria-hidden");return n&&t.push(`role="${n}"`),o&&t.push(`aria-label="${o}"`),r&&t.push(`aria-describedby="${r}"`),l&&t.push(`tabindex=${l}`),i==="true"&&t.push("aria-hidden"),e.matches("a, button, input, select, textarea, [tabindex]")&&t.push("focusable"),t.join(", ")}function Ca(e){let t=[],n=e;for(;n&&n.tagName.toLowerCase()!=="html";){let o=n.tagName.toLowerCase(),r=o;if(n.id)r=`${o}#${n.id}`;else if(n.className&&typeof n.className=="string"){let i=n.className.split(/\s+/).map(s=>s.replace(/[_][a-zA-Z0-9]{5,}.*$/,"")).find(s=>s.length>2);i&&(r=`${o}.${i}`)}let l=Cl(n);!n.parentElement&&l&&(r=`\u27E8shadow\u27E9 ${r}`),t.unshift(r),n=l}return t.join(" > ")}var V5=new Set(["nav","header","main","section","article","footer","aside"]),Lu={banner:"Header",navigation:"Navigation",main:"Main Content",contentinfo:"Footer",complementary:"Sidebar",region:"Section"},qh={nav:"Navigation",header:"Header",main:"Main Content",section:"Section",article:"Article",footer:"Footer",aside:"Sidebar"},K5=new Set(["script","style","noscript","link","meta"]),G5=40;function Cp(e){let t=e;for(;t&&t!==document.body&&t!==document.documentElement;){let n=window.getComputedStyle(t).position;if(n==="fixed"||n==="sticky")return!0;t=t.parentElement}return!1}function Rr(e){let t=e.tagName.toLowerCase();if(["nav","header","footer","main"].includes(t)&&document.querySelectorAll(t).length===1)return t;if(e.id)return`#${CSS.escape(e.id)}`;if(e.className&&typeof e.className=="string"){let r=e.className.split(/\s+/).filter(l=>l.length>0).find(l=>l.length>2&&!/^[a-zA-Z0-9]{6,}$/.test(l)&&!/^[a-z]{1,2}$/.test(l));if(r){let l=`${t}.${CSS.escape(r)}`;if(document.querySelectorAll(l).length===1)return l}}let n=e.parentElement;if(n){let r=Array.from(n.children).indexOf(e)+1;return`${n===document.body?"body":Rr(n)} > ${t}:nth-child(${r})`}return t}function Ra(e){let t=e.tagName.toLowerCase(),n=e.getAttribute("aria-label");if(n)return n;let o=e.getAttribute("role");if(o&&Lu[o])return Lu[o];if(qh[t])return qh[t];let r=e.querySelector("h1, h2, h3, h4, h5, h6");if(r){let i=r.textContent?.trim();if(i&&i.length<=50)return i;if(i)return i.slice(0,47)+"..."}let{name:l}=wl(e);return l.charAt(0).toUpperCase()+l.slice(1)}function Sp(e){let t=e.className;return typeof t!="string"||!t?null:t.split(/\s+/).map(o=>o.replace(/[_][a-zA-Z0-9]{5,}.*$/,"")).find(o=>o.length>2&&!/^[a-z]{1,2}$/.test(o))||null}function Mp(e){let t=e.textContent?.trim();if(!t)return null;let n=t.replace(/\s+/g," ");return n.length<=30?n:n.slice(0,30)+"\u2026"}function q5(){let e=document.querySelector("main")||document.body,t=Array.from(e.children),n=t;e!==document.body&&t.length<3&&(n=Array.from(document.body.children));let o=[];return n.forEach((r,l)=>{if(!(r instanceof HTMLElement))return;let i=r.tagName.toLowerCase();if(K5.has(i)||r.hasAttribute("data-feedback-toolbar")||r.closest("[data-feedback-toolbar]"))return;let s=window.getComputedStyle(r);if(s.display==="none"||s.visibility==="hidden")return;let a=r.getBoundingClientRect();if(a.height<G5)return;let m=V5.has(i),p=r.getAttribute("role")&&Lu[r.getAttribute("role")],b=i==="div"&&a.height>=60;if(!m&&!p&&!b)return;let y=window.scrollY,$=Cp(r),C={x:a.x,y:$?a.y:a.y+y,width:a.width,height:a.height};o.push({id:`rs-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,label:Ra(r),tagName:i,selector:Rr(r),role:r.getAttribute("role"),className:Sp(r),textSnippet:Mp(r),originalRect:C,currentRect:{...C},originalIndex:l,isFixed:$})}),o}function Z5(e){let t=window.scrollY,n=e.getBoundingClientRect(),o=Cp(e),r={x:n.x,y:o?n.y:n.y+t,width:n.width,height:n.height},l=e.parentElement,i=0;return l&&(i=Array.from(l.children).indexOf(e)),{id:`rs-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,label:Ra(e),tagName:e.tagName.toLowerCase(),selector:Rr(e),role:e.getAttribute("role"),className:Sp(e),textSnippet:Mp(e),originalRect:r,currentRect:{...r},originalIndex:i,isFixed:o}}var Zh={bg:"rgba(59, 130, 246, 0.08)",border:"rgba(59, 130, 246, 0.5)",pill:"#3b82f6"},Jh=["nw","n","ne","e","se","s","sw","w"],Sa=24,ep=16,Ma=5;function tp(e,t,n,o){let r=1/0,l=1/0,i=e.x,s=e.x+e.width,a=e.x+e.width/2,m=e.y,p=e.y+e.height,b=e.y+e.height/2,y=[];for(let D of t)n.has(D.id)||y.push(D.currentRect);o&&y.push(...o);for(let D of y){let G=D.x,ye=D.x+D.width,Z=D.x+D.width/2,he=D.y,Ge=D.y+D.height,it=D.y+D.height/2;for(let Re of[i,s,a])for(let We of[G,ye,Z]){let Ee=We-Re;Math.abs(Ee)<Ma&&Math.abs(Ee)<Math.abs(r)&&(r=Ee)}for(let Re of[m,p,b])for(let We of[he,Ge,it]){let Ee=We-Re;Math.abs(Ee)<Ma&&Math.abs(Ee)<Math.abs(l)&&(l=Ee)}}let $=Math.abs(r)<Ma?r:0,C=Math.abs(l)<Ma?l:0,I=[],E=new Set,f=i+$,g=s+$,w=a+$,N=m+C,H=p+C,V=b+C;for(let D of y){let G=D.x,ye=D.x+D.width,Z=D.x+D.width/2,he=D.y,Ge=D.y+D.height,it=D.y+D.height/2;for(let Re of[G,Z,ye])for(let We of[f,w,g])if(Math.abs(We-Re)<.5){let Ee=`x:${Math.round(Re)}`;E.has(Ee)||(E.add(Ee),I.push({axis:"x",pos:Re}))}for(let Re of[he,it,Ge])for(let We of[N,V,H])if(Math.abs(We-Re)<.5){let Ee=`y:${Math.round(Re)}`;E.has(Ee)||(E.add(Ee),I.push({axis:"y",pos:Re}))}}return{dx:$,dy:C,guides:I}}var J5=new Set(["script","style","noscript","link","meta","br","hr"]);function np(e){let t=e;for(;t&&t!==document.body&&t!==document.documentElement;){if(t.closest("[data-feedback-toolbar]"))return null;if(J5.has(t.tagName.toLowerCase())){t=t.parentElement;continue}let n=t.getBoundingClientRect();if(n.width>=ep&&n.height>=ep)return t;t=t.parentElement}return null}function e2({rearrangeState:e,onChange:t,isDarkMode:n,exiting:o,className:r,blankCanvas:l,extraSnapRects:i,onSelectionChange:s,deselectSignal:a,onDragMove:m,onDragEnd:p,clearSignal:b}){let{sections:y}=e,$=(0,ke.useRef)(e);$.current=e;let[C,I]=(0,ke.useState)(new Set),[E,f]=(0,ke.useState)(!1),g=(0,ke.useRef)(b);(0,ke.useEffect)(()=>{b!==void 0&&b!==g.current&&(g.current=b,y.length>0&&f(!0))},[b,y.length]);let w=(0,ke.useRef)(a);(0,ke.useEffect)(()=>{a!==w.current&&(w.current=a,I(new Set))},[a]);let[N,H]=(0,ke.useState)(null),[V,D]=(0,ke.useState)(!1),G=(0,ke.useRef)(!1),ye=(0,ke.useCallback)(S=>{let L=y.find(B=>B.id===S);L&&(G.current=!!L.note,H(S),D(!1))},[y]),Z=(0,ke.useCallback)(()=>{N&&(D(!0),fe(()=>{H(null),D(!1)},150))},[N]),he=(0,ke.useCallback)(S=>{N&&(t({...e,sections:y.map(L=>L.id===N?{...L,note:S.trim()||void 0}:L)}),Z())},[N,y,e,t,Z]);(0,ke.useEffect)(()=>{o&&N&&Z()},[o]);let[Ge,it]=(0,ke.useState)(new Set),Re=(0,ke.useRef)(new Map),[We,Ee]=(0,ke.useState)(null),[Ke,X]=(0,ke.useState)(null),[me,Ue]=(0,ke.useState)([]),[Mt,cn]=(0,ke.useState)(0),en=(0,ke.useRef)(null),$o=(0,ke.useRef)(new Set),Sn=(0,ke.useRef)(new Map),[Ro,On]=(0,ke.useState)(new Map),[mo,To]=(0,ke.useState)(new Map),rr=(0,ke.useRef)(new Set),gn=(0,ke.useRef)(new Map),An=(0,ke.useRef)(s);An.current=s;let dn=(0,ke.useRef)(m);dn.current=m;let eo=(0,ke.useRef)(p);eo.current=p,(0,ke.useEffect)(()=>{l&&I(new Set)},[l]);let[to,Tr]=(0,ke.useState)(()=>!e.sections.some(S=>{let L=S.originalRect,B=S.currentRect;return Math.abs(L.x-B.x)>1||Math.abs(L.y-B.y)>1||Math.abs(L.width-B.width)>1||Math.abs(L.height-B.height)>1}));(0,ke.useEffect)(()=>{if(!to){let S=fe(()=>Tr(!0),380);return()=>clearTimeout(S)}},[]);let Wn=(0,ke.useRef)(new Set);(0,ke.useEffect)(()=>{Wn.current=new Set(y.map(S=>S.selector))},[y]),(0,ke.useEffect)(()=>{let S=()=>cn(window.scrollY);return S(),window.addEventListener("scroll",S,{passive:!0}),window.addEventListener("resize",S,{passive:!0}),()=>{window.removeEventListener("scroll",S),window.removeEventListener("resize",S)}},[]),(0,ke.useEffect)(()=>{let S=L=>{if(en.current){Ee(null);return}let B=document.elementFromPoint(L.clientX,L.clientY);if(!B){Ee(null);return}if(B.closest("[data-feedback-toolbar]")){Ee(null);return}if(B.closest("[data-design-placement]")){Ee(null);return}if(B.closest("[data-annotation-popup]")){Ee(null);return}let O=np(B);if(!O){Ee(null);return}for(let le of Wn.current)try{let F=document.querySelector(le);if(F&&(F===O||O.contains(F))){Ee(null);return}}catch{}let J=O.getBoundingClientRect();Ee({x:J.x,y:J.y,w:J.width,h:J.height})};return document.addEventListener("mousemove",S,{passive:!0}),()=>document.removeEventListener("mousemove",S)},[y]),(0,ke.useEffect)(()=>{let S=document.body.style.userSelect;return document.body.style.userSelect="none",()=>{document.body.style.userSelect=S}},[]),(0,ke.useEffect)(()=>{let S=L=>{if(en.current||L.button!==0)return;let B=L.target;if(!B||B.closest("[data-feedback-toolbar]")||B.closest("[data-design-placement]")||B.closest("[data-annotation-popup]"))return;let O=np(B),J=!1;if(O)for(let F of Wn.current)try{let ie=document.querySelector(F);if(ie&&(ie===O||O.contains(ie))){J=!0;break}}catch{}let le=!!(L.shiftKey||L.metaKey||L.ctrlKey);if(O&&!J){L.preventDefault(),L.stopPropagation();let F=Z5(O),ie=[...y,F],Se=[...e.originalOrder,F.id];t({...e,sections:ie,originalOrder:Se});let Fe=new Set([F.id]);I(Fe),An.current?.(Fe,le),Ee(null);let Ze=L.clientX,se=L.clientY,tt={x:F.currentRect.x,y:F.currentRect.y},Pe=F.originalRect,Le=!1,ae=0,nt=0;en.current="move";let je=Xe=>{let we=Xe.clientX-Ze,ut=Xe.clientY-se;if(!Le&&(Math.abs(we)>2||Math.abs(ut)>2)&&(Le=!0),!Le)return;let Ft={x:tt.x+we,y:tt.y+ut,width:F.currentRect.width,height:F.currentRect.height},Mn=tp(Ft,ie,new Set([F.id]),i);Ue(Mn.guides);let no=we+Mn.dx,un=ut+Mn.dy;ae=no,nt=un;let go=document.querySelector(`[data-rearrange-section="${F.id}"]`);go&&(go.style.transform=`translate(${no}px, ${un}px)`),On(new Map([[F.id,{x:tt.x+no,y:tt.y+un,width:F.currentRect.width,height:F.currentRect.height}]])),dn.current?.(no,un)},Ie=()=>{window.removeEventListener("mousemove",je),window.removeEventListener("mouseup",Ie),en.current=null,Ue([]),On(new Map);let Xe=document.querySelector(`[data-rearrange-section="${F.id}"]`);Xe&&(Xe.style.transform=""),Le&&t({...e,sections:ie.map(we=>we.id===F.id?{...we,currentRect:{...we.currentRect,x:Math.max(0,tt.x+ae),y:Math.max(0,tt.y+nt)}}:we),originalOrder:Se}),eo.current?.(ae,nt,Le)};window.addEventListener("mousemove",je),window.addEventListener("mouseup",Ie)}else if(J&&O){L.preventDefault();for(let F of y)try{let ie=document.querySelector(F.selector);if(ie&&ie===O){let Se=new Set([F.id]);I(Se),An.current?.(Se,le);return}}catch{}le||(I(new Set),An.current?.(new Set,!1))}else le||(I(new Set),An.current?.(new Set,!1))};return document.addEventListener("mousedown",S,!0),()=>document.removeEventListener("mousedown",S,!0)},[y,e,t]),(0,ke.useEffect)(()=>{let S=L=>{let B=L.target;if(!(B.tagName==="INPUT"||B.tagName==="TEXTAREA"||B.isContentEditable)){if((L.key==="Backspace"||L.key==="Delete")&&C.size>0){L.preventDefault();let O=new Set(C);it(J=>{let le=new Set(J);for(let F of O)le.add(F);return le}),I(new Set),fe(()=>{let J=$.current;t({...J,sections:J.sections.filter(le=>!O.has(le.id)),originalOrder:J.originalOrder.filter(le=>!O.has(le))}),it(le=>{let F=new Set(le);for(let ie of O)F.delete(ie);return F})},180);return}if(["ArrowUp","ArrowDown","ArrowLeft","ArrowRight"].includes(L.key)&&C.size>0){L.preventDefault();let O=L.shiftKey?20:1,J=L.key==="ArrowLeft"?-O:L.key==="ArrowRight"?O:0,le=L.key==="ArrowUp"?-O:L.key==="ArrowDown"?O:0;t({...e,sections:y.map(F=>C.has(F.id)?{...F,currentRect:{...F.currentRect,x:Math.max(0,F.currentRect.x+J),y:Math.max(0,F.currentRect.y+le)}}:F)});return}L.key==="Escape"&&C.size>0&&I(new Set)}};return document.addEventListener("keydown",S),()=>document.removeEventListener("keydown",S)},[C,y,e,t]);let Te=(0,ke.useCallback)((S,L)=>{if(S.button!==0)return;let B=S.target;if(B.closest(`.${T.handle}`)||B.closest(`.${T.deleteButton}`))return;S.preventDefault(),S.stopPropagation();let O;S.shiftKey||S.metaKey||S.ctrlKey?(O=new Set(C),O.has(L)?O.delete(L):O.add(L)):C.has(L)?O=new Set(C):O=new Set([L]),I(O),(O.size!==C.size||[...O].some(Le=>!C.has(Le)))&&An.current?.(O,!!(S.shiftKey||S.metaKey||S.ctrlKey));let le=S.clientX,F=S.clientY,ie=new Map;for(let Le of y)O.has(Le.id)&&ie.set(Le.id,{x:Le.currentRect.x,y:Le.currentRect.y});en.current="move";let Se=!1,Fe=0,Ze=0,se=new Map;for(let Le of y)if(O.has(Le.id)){let ae=document.querySelector(`[data-rearrange-section="${Le.id}"]`);se.set(Le.id,{outlineEl:ae,curW:Le.currentRect.width,curH:Le.currentRect.height})}let tt=Le=>{let ae=Le.clientX-le,nt=Le.clientY-F;if(ae===0&&nt===0)return;Se=!0;let je=1/0,Ie=1/0,Xe=-1/0,we=-1/0;for(let[un,{curW:go,curH:zi}]of se){let It=ie.get(un);if(!It)continue;let yo=It.x+ae,Oi=It.y+nt;je=Math.min(je,yo),Ie=Math.min(Ie,Oi),Xe=Math.max(Xe,yo+go),we=Math.max(we,Oi+zi)}let ut=tp({x:je,y:Ie,width:Xe-je,height:we-Ie},y,O,i),Ft=ae+ut.dx,Mn=nt+ut.dy;Fe=Ft,Ze=Mn,Ue(ut.guides);for(let[,{outlineEl:un}]of se)un&&(un.style.transform=`translate(${Ft}px, ${Mn}px)`);let no=new Map;for(let[un,{curW:go,curH:zi}]of se){let It=ie.get(un);if(It){let yo={x:Math.max(0,It.x+Ft),y:Math.max(0,It.y+Mn),width:go,height:zi};no.set(un,yo)}}On(no),dn.current?.(Ft,Mn)},Pe=Le=>{window.removeEventListener("mousemove",tt),window.removeEventListener("mouseup",Pe),en.current=null,Ue([]),On(new Map);for(let[,{outlineEl:ae}]of se)ae&&(ae.style.transform="");if(Se){let ae=Le.clientX-le,nt=Le.clientY-F;if(Math.abs(ae)<5&&Math.abs(nt)<5)t({...e,sections:y.map(je=>{let Ie=ie.get(je.id);return Ie?{...je,currentRect:{...je.currentRect,x:Ie.x,y:Ie.y}}:je})});else{t({...e,sections:y.map(je=>{let Ie=ie.get(je.id);return Ie?{...je,currentRect:{...je.currentRect,x:Math.max(0,Ie.x+Fe),y:Math.max(0,Ie.y+Ze)}}:je})}),eo.current?.(Fe,Ze,!0);return}}eo.current?.(0,0,!1)};window.addEventListener("mousemove",tt),window.addEventListener("mouseup",Pe)},[C,y,e,t]),U=(0,ke.useCallback)((S,L,B)=>{S.preventDefault(),S.stopPropagation();let O=y.find(Pe=>Pe.id===L);if(!O)return;I(new Set([L])),en.current="resize";let J=S.clientX,le=S.clientY,F={...O.currentRect},ie=O.originalRect,Se=F.width/F.height,Fe={...F},Ze=document.querySelector(`[data-rearrange-section="${L}"]`),se=Pe=>{let Le=Pe.clientX-J,ae=Pe.clientY-le,nt=F.x,je=F.y,Ie=F.width,Xe=F.height;if(B.includes("e")&&(Ie=Math.max(Sa,F.width+Le)),B.includes("w")&&(Ie=Math.max(Sa,F.width-Le),nt=F.x+F.width-Ie),B.includes("s")&&(Xe=Math.max(Sa,F.height+ae)),B.includes("n")&&(Xe=Math.max(Sa,F.height-ae),je=F.y+F.height-Xe),Pe.shiftKey)if(B.length===2){let ut=Math.abs(Ie-F.width),Ft=Math.abs(Xe-F.height);ut>Ft?Xe=Ie/Se:Ie=Xe*Se,B.includes("w")&&(nt=F.x+F.width-Ie),B.includes("n")&&(je=F.y+F.height-Xe)}else B==="e"||B==="w"?Xe=Ie/Se:Ie=Xe*Se,B==="w"&&(nt=F.x+F.width-Ie),B==="n"&&(je=F.y+F.height-Xe);Fe={x:nt,y:je,width:Ie,height:Xe},Ze&&(Ze.style.left=`${nt}px`,Ze.style.top=`${je-Mt}px`,Ze.style.width=`${Ie}px`,Ze.style.height=`${Xe}px`),X({x:Pe.clientX+12,y:Pe.clientY+12,text:`${Math.round(Ie)} \xD7 ${Math.round(Xe)}`}),On(new Map([[L,Fe]]))},tt=()=>{window.removeEventListener("mousemove",se),window.removeEventListener("mouseup",tt),X(null),en.current=null,On(new Map),t({...e,sections:y.map(Pe=>Pe.id===L?{...Pe,currentRect:Fe}:Pe)})};window.addEventListener("mousemove",se),window.addEventListener("mouseup",tt)},[y,e,t,Mt]),ue=(0,ke.useCallback)(S=>{it(L=>{let B=new Set(L);return B.add(S),B}),I(L=>{let B=new Set(L);return B.delete(S),B}),fe(()=>{let L=$.current;t({...L,sections:L.sections.filter(B=>B.id!==S),originalOrder:L.originalOrder.filter(B=>B!==S)}),it(B=>{let O=new Set(B);return O.delete(S),O})},180)},[t]),xe=S=>{let L=S.originalRect,B=S.currentRect;return Math.abs(L.x-B.x)>1||Math.abs(L.y-B.y)>1||Math.abs(L.width-B.width)>1||Math.abs(L.height-B.height)>1},$e=S=>{let L=S.originalRect,B=S.currentRect;return Math.abs(L.x-B.x)>1||Math.abs(L.y-B.y)>1},ve=S=>{let L=S.originalRect,B=S.currentRect;return Math.abs(L.width-B.width)>1||Math.abs(L.height-B.height)>1};for(let S of y)Sn.current.has(S.id)||($e(S)?Sn.current.set(S.id,"move"):ve(S)&&Sn.current.set(S.id,"resize"));for(let S of Sn.current.keys())y.some(L=>L.id===S)||Sn.current.delete(S);let qe=y.filter(S=>{try{if(Ge.has(S.id)||C.has(S.id))return!0;let L=document.querySelector(S.selector);if(!L)return!1;let B=L.getBoundingClientRect(),O=S.originalRect;return Math.abs(B.width-O.width)+Math.abs(B.height-O.height)<200}catch{return!1}}),et=qe.filter(S=>xe(S)),Ye=qe.filter(S=>!xe(S)),ze=new Set(et.map(S=>S.id));for(let S of $o.current)ze.has(S)||$o.current.delete(S);let pe=[...ze].sort().join(",");for(let S of et)gn.current.set(S.id,{currentRect:S.currentRect,originalRect:S.originalRect,isFixed:S.isFixed});return(0,ke.useEffect)(()=>{let S=rr.current;rr.current=ze;let L=new Map;for(let B of S)if(!ze.has(B)){if(!y.some(J=>J.id===B))continue;let O=gn.current.get(B);O&&(L.set(B,{orig:O.originalRect,target:O.currentRect,isFixed:O.isFixed}),gn.current.delete(B))}if(L.size>0){To(O=>{let J=new Map(O);for(let[le,F]of L)J.set(le,F);return J});let B=fe(()=>{To(O=>{let J=new Map(O);for(let le of L.keys())J.delete(le);return J})},250);return()=>clearTimeout(B)}},[pe,y]),(0,He.jsxs)(He.Fragment,{children:[(0,He.jsxs)("div",{className:`${T.rearrangeOverlay} ${n?"":T.light} ${o?T.overlayExiting:""}${r?` ${r}`:""}`,"data-feedback-toolbar":!0,children:[We&&(0,He.jsx)("div",{className:T.hoverHighlight,style:{left:We.x,top:We.y,width:We.w,height:We.h}}),Ye.map(S=>{let L=S.currentRect,B=S.isFixed?L.y:L.y-Mt,O=Zh,J=C.has(S.id);return(0,He.jsxs)("div",{"data-rearrange-section":S.id,className:`${T.sectionOutline} ${J?T.selected:""} ${E||o||Ge.has(S.id)?T.exiting:""}`,style:{left:L.x,top:B,width:L.width,height:L.height,borderColor:O.border,backgroundColor:O.bg,...to?{}:{opacity:0,animation:"none",transition:"none"}},onMouseDown:le=>Te(le,S.id),onDoubleClick:()=>ye(S.id),children:[(0,He.jsx)("span",{className:T.sectionLabel,style:{backgroundColor:O.pill},children:S.label}),(0,He.jsx)("span",{className:`${T.sectionAnnotation} ${S.note?T.annotationVisible:""}`,children:(S.note&&Re.current.set(S.id,S.note),S.note||Re.current.get(S.id)||"")}),(0,He.jsxs)("span",{className:T.sectionDimensions,children:[Math.round(L.width)," \xD7 ",Math.round(L.height)]}),(0,He.jsx)("div",{className:T.deleteButton,onMouseDown:le=>le.stopPropagation(),onClick:()=>ue(S.id),children:"\u2715"}),Jh.map(le=>(0,He.jsx)("div",{className:`${T.handle} ${T[`handle${le.charAt(0).toUpperCase()}${le.slice(1)}`]}`,onMouseDown:F=>U(F,S.id,le)},le))]},S.id)}),et.map(S=>{let L=S.currentRect,B=S.isFixed?L.y:L.y-Mt,O=C.has(S.id),J=$e(S),le=ve(S);if(l&&!O)return null;let ie=!$o.current.has(S.id);return ie&&$o.current.add(S.id),(0,He.jsxs)("div",{"data-rearrange-section":S.id,className:`${T.ghostOutline} ${O?T.selected:""} ${E||o||Ge.has(S.id)?T.exiting:""}`,style:{left:L.x,top:B,width:L.width,height:L.height,...to?{}:{opacity:0,animation:"none",transition:"none"},...ie?{}:{animation:"none"}},onMouseDown:Se=>Te(Se,S.id),onDoubleClick:()=>ye(S.id),children:[(0,He.jsx)("span",{className:T.sectionLabel,style:{backgroundColor:Zh.pill},children:S.label}),(0,He.jsx)("span",{className:`${T.sectionAnnotation} ${S.note?T.annotationVisible:""}`,children:(S.note&&Re.current.set(S.id,S.note),S.note||Re.current.get(S.id)||"")}),(0,He.jsxs)("span",{className:T.sectionDimensions,children:[Math.round(L.width)," \xD7 ",Math.round(L.height)]}),(0,He.jsx)("div",{className:T.deleteButton,onMouseDown:Se=>Se.stopPropagation(),onClick:()=>ue(S.id),children:"\u2715"}),Jh.map(Se=>(0,He.jsx)("div",{className:`${T.handle} ${T[`handle${Se.charAt(0).toUpperCase()}${Se.slice(1)}`]}`,onMouseDown:Fe=>U(Fe,S.id,Se)},Se)),(0,He.jsx)("span",{className:T.ghostBadge,children:(()=>{let Se=Sn.current.get(S.id);if(J&&le){let[Fe,Ze]=Se==="resize"?["Resize","Move"]:["Move","Resize"];return(0,He.jsxs)(He.Fragment,{children:["Suggested ",Fe," ",(0,He.jsxs)("span",{className:T.ghostBadgeExtra,children:["& ",Ze]})]})}return`Suggested ${le?"Resize":"Move"}`})()})]},S.id)})]}),!l&&(()=>{let S=[];for(let L of et){let B=Ro.get(L.id);S.push({id:L.id,orig:L.originalRect,target:B||L.currentRect,isFixed:L.isFixed,isSelected:C.has(L.id),isExiting:Ge.has(L.id)})}for(let[L,B]of Ro)if(!S.some(O=>O.id===L)){let O=y.find(J=>J.id===L);O&&S.push({id:L,orig:O.originalRect,target:B,isFixed:O.isFixed,isSelected:C.has(L)})}for(let[L,B]of mo)S.some(O=>O.id===L)||S.push({id:L,orig:B.orig,target:B.target,isFixed:B.isFixed,isSelected:!1,isExiting:!0});return S.length===0?null:(0,He.jsxs)("svg",{className:`${T.connectorSvg} ${E||o?T.connectorExiting:""}`,children:[S.map(({id:L,orig:B,target:O,isFixed:J,isSelected:le,isExiting:F})=>{let ie=B.x+B.width/2,Se=(J?B.y:B.y-Mt)+B.height/2,Fe=O.x+O.width/2,Ze=(J?O.y:O.y-Mt)+O.height/2,se=Fe-ie,tt=Ze-Se,Pe=Math.sqrt(se*se+tt*tt);if(Pe<2)return null;let Le=Math.min(1,Pe/40),ae=Math.min(Pe*.3,60),nt=Pe>0?-tt/Pe:0,je=Pe>0?se/Pe:0,Ie=(ie+Fe)/2+nt*ae,Xe=(Se+Ze)/2+je*ae,we=Ro.has(L),ut=we||le?1:.4,Ft=we||le?1:.5;return(0,He.jsxs)("g",{className:F?T.connectorExiting:"",children:[(0,He.jsx)("path",{className:T.connectorLine,d:`M ${ie} ${Se} Q ${Ie} ${Xe} ${Fe} ${Ze}`,fill:"none",stroke:"rgba(59, 130, 246, 0.45)",strokeWidth:"1.5",opacity:ut*Le}),(0,He.jsx)("circle",{className:T.connectorDot,cx:ie,cy:Se,r:4*Le,fill:"rgba(59, 130, 246, 0.8)",stroke:"#fff",strokeWidth:"1.5",opacity:Ft*Le,filter:"url(#connDotShadow)"}),(0,He.jsx)("circle",{className:T.connectorDot,cx:Fe,cy:Ze,r:4*Le,fill:"rgba(59, 130, 246, 0.8)",stroke:"#fff",strokeWidth:"1.5",opacity:Ft*Le,filter:"url(#connDotShadow)"})]},`conn-${L}`)}),(0,He.jsx)("defs",{children:(0,He.jsx)("filter",{id:"connDotShadow",x:"-50%",y:"-50%",width:"200%",height:"200%",children:(0,He.jsx)("feDropShadow",{dx:"0",dy:"0.5",stdDeviation:"1",floodOpacity:"0.15"})})})]})})(),N&&(()=>{let S=y.find(Ze=>Ze.id===N);if(!S)return null;let L=S.currentRect,B=S.isFixed?L.y:L.y-Mt,O=L.x+L.width/2,J=B-8,le=B+L.height+8,F=J>200,ie=le<window.innerHeight-100,Se=Math.max(160,Math.min(window.innerWidth-160,O)),Fe;return F?Fe={left:Se,bottom:window.innerHeight-J}:ie?Fe={left:Se,top:le}:Fe={left:Se,top:Math.max(80,window.innerHeight/2-80)},(0,He.jsx)($a,{element:S.label,placeholder:"Add a note about this section",initialValue:S.note??"",submitLabel:G.current?"Save":"Set",onSubmit:he,onCancel:Z,onDelete:G.current?()=>{he("")}:void 0,isExiting:V,lightMode:!n,style:Fe})})(),Ke&&(0,He.jsx)("div",{className:T.sizeIndicator,style:{left:Ke.x,top:Ke.y},"data-feedback-toolbar":!0,children:Ke.text}),me.map((S,L)=>(0,He.jsx)("div",{className:T.guideLine,style:S.axis==="x"?{position:"fixed",left:S.pos,top:0,width:1,height:"100vh"}:{position:"fixed",left:0,top:S.pos-Mt,width:"100vw",height:1}},`${S.axis}-${S.pos}-${L}`))]})}var Iu=new Set(["script","style","noscript","link","meta","br","hr"]);function t2(){let e=document.querySelector("main")||document.body,t=[],n=Array.from(e.children),o=e!==document.body&&n.length<3?Array.from(document.body.children):n;for(let r of o){if(!(r instanceof HTMLElement)||Iu.has(r.tagName.toLowerCase())||r.hasAttribute("data-feedback-toolbar"))continue;let l=window.getComputedStyle(r);if(l.display==="none"||l.visibility==="hidden")continue;let i=r.getBoundingClientRect();if(!(i.height<10||i.width<10)){t.push({label:Ra(r),selector:Rr(r),top:i.top,bottom:i.bottom,left:i.left,right:i.right,area:i.width*i.height});for(let s of Array.from(r.children)){if(!(s instanceof HTMLElement)||Iu.has(s.tagName.toLowerCase())||s.hasAttribute("data-feedback-toolbar"))continue;let a=window.getComputedStyle(s);if(a.display==="none"||a.visibility==="hidden")continue;let m=s.getBoundingClientRect();m.height<10||m.width<10||t.push({label:Ra(s),selector:Rr(s),top:m.top,bottom:m.bottom,left:m.left,right:m.right,area:m.width*m.height})}}}return t}function n2(e){let t=window.scrollY;return e.map(({label:n,selector:o,rect:r})=>{let l=r.y-t;return{label:n,selector:o,top:l,bottom:l+r.height,left:r.x,right:r.x+r.width,area:r.width*r.height}})}function o2(e){let t=window.scrollY,n=e.y-t,o=e.x;return{top:n,bottom:n+e.height,left:o,right:o+e.width,area:e.width*e.height}}function Nu(e,t){let n=t?n2(t):t2(),o=o2(e),r=null,l=null,i=null,s=null,a=null;for(let C of n){if(Math.abs(C.left-o.left)<2&&Math.abs(C.top-o.top)<2&&Math.abs(C.right-C.left-e.width)<2&&Math.abs(C.bottom-C.top-e.height)<2)continue;C.left<=o.left+2&&C.right>=o.right-2&&C.top<=o.top+2&&C.bottom>=o.bottom-2&&C.area>o.area*1.5&&(!a||C.area<a._area)&&(a={label:C.label,selector:C.selector,_area:C.area});let I=o.right>C.left+5&&o.left<C.right-5,E=o.bottom>C.top+5&&o.top<C.bottom-5;if(I&&C.bottom<=o.top+5){let f=Math.round(o.top-C.bottom);(!r||f<r._dist)&&(r={label:C.label,selector:C.selector,gap:Math.max(0,f),_dist:f})}if(I&&C.top>=o.bottom-5){let f=Math.round(C.top-o.bottom);(!l||f<l._dist)&&(l={label:C.label,selector:C.selector,gap:Math.max(0,f),_dist:f})}if(E&&C.right<=o.left+5){let f=Math.round(o.left-C.right);(!i||f<i._dist)&&(i={label:C.label,selector:C.selector,gap:Math.max(0,f),_dist:f})}if(E&&C.left>=o.right-5){let f=Math.round(C.left-o.right);(!s||f<s._dist)&&(s={label:C.label,selector:C.selector,gap:Math.max(0,f),_dist:f})}}let m=window.innerWidth,p=window.innerHeight,b=l2(e,m),y=C=>C?{label:C.label,selector:C.selector,gap:C.gap}:null,$=r2(o,e,m,p,a?{label:a.label,selector:a.selector,_area:a._area}:null,n);return{above:y(r),below:y(l),left:y(i),right:y(s),alignment:b,containedIn:a?{label:a.label,selector:a.selector}:null,outOfBounds:$}}function r2(e,t,n,o,r,l){let i={},s=!1,a=[];if(e.left<-2&&a.push("left"),e.right>n+2&&a.push("right"),e.top<-2&&a.push("top"),e.bottom>o+2&&a.push("bottom"),a.length>0&&(i.viewport=a,s=!0),r){let m=l.find(p=>p.label===r.label&&p.selector===r.selector&&Math.abs(p.area-r._area)<10);if(m){let p=[];e.left<m.left-2&&p.push("left"),e.right>m.right+2&&p.push("right"),e.top<m.top-2&&p.push("top"),e.bottom>m.bottom+2&&p.push("bottom"),p.length>0&&(i.container={label:r.label,edges:p},s=!0)}}return s?i:null}function l2(e,t){if(e.width/t>.85)return"full-width";let o=e.x+e.width/2,r=t/2,l=o-r,i=t*.08;return Math.abs(l)<i?"center":l<0?"left":"right"}function Ep(e){switch(e){case"full-width":return"full-width";case"center":return"centered";case"left":return"left-aligned";case"right":return"right-aligned"}}function Lp(e,t={}){let n=[];e.above&&n.push(`Below \`${e.above.label}\`${e.above.gap>0?` (${e.above.gap}px gap)`:""}`),e.below&&n.push(`Above \`${e.below.label}\`${e.below.gap>0?` (${e.below.gap}px gap)`:""}`),t.includeLeftRight&&(e.left&&n.push(`Right of \`${e.left.label}\`${e.left.gap>0?` (${e.left.gap}px gap)`:""}`),e.right&&n.push(`Left of \`${e.right.label}\`${e.right.gap>0?` (${e.right.gap}px gap)`:""}`));let o=Ep(e.alignment);return e.containedIn?n.push(`${o.charAt(0).toUpperCase()+o.slice(1)} in \`${e.containedIn.label}\``):n.push(`${o.charAt(0).toUpperCase()+o.slice(1)} in page`),t.includePixelRef&&t.pixelRef&&n.push(`Pixel ref: \`${t.pixelRef}\``),e.outOfBounds&&(e.outOfBounds.viewport&&n.push(`**Outside viewport** (${e.outOfBounds.viewport.join(", ")} edge${e.outOfBounds.viewport.length>1?"s":""})`),e.outOfBounds.container&&n.push(`**Outside \`${e.outOfBounds.container.label}\`** (${e.outOfBounds.container.edges.join(", ")} edge${e.outOfBounds.container.edges.length>1?"s":""})`)),n}function i2(e,t,n){let o=[];e.above&&o.push(`below \`${e.above.label}\``),e.below&&o.push(`above \`${e.below.label}\``),e.left&&o.push(`right of \`${e.left.label}\``),e.right&&o.push(`left of \`${e.right.label}\``),e.containedIn&&o.push(`inside \`${e.containedIn.label}\``),o.push(Ep(e.alignment)),e.outOfBounds?.viewport&&o.push(`**outside viewport** (${e.outOfBounds.viewport.join(", ")})`),e.outOfBounds?.container&&o.push(`**outside \`${e.outOfBounds.container.label}\`** (${e.outOfBounds.container.edges.join(", ")})`);let r=n?`, ${Math.round(n.width)}\xD7${Math.round(n.height)}px`:"";return`at (${Math.round(t.x)}, ${Math.round(t.y)})${r}: ${o.join(", ")}`}var op=15;function rp(e){if(e.length<2)return[];let t=[],n=new Set;for(let o=0;o<e.length;o++){if(n.has(o))continue;let r=[o];for(let l=o+1;l<e.length;l++)n.has(l)||Math.abs(e[o].rect.y-e[l].rect.y)<op&&r.push(l);if(r.length>=2){let l=r.map(a=>e[a]);l.sort((a,m)=>a.rect.x-m.rect.x);let i=[];for(let a=0;a<l.length-1;a++)i.push(Math.round(l[a+1].rect.x-(l[a].rect.x+l[a].rect.width)));let s=Math.round(l.reduce((a,m)=>a+m.rect.y,0)/l.length);t.push({labels:l.map(a=>a.label),type:"row",sharedEdge:s,gaps:i,avgGap:i.length?Math.round(i.reduce((a,m)=>a+m,0)/i.length):0}),r.forEach(a=>n.add(a))}}for(let o=0;o<e.length;o++){if(n.has(o))continue;let r=[o];for(let l=o+1;l<e.length;l++)n.has(l)||Math.abs(e[o].rect.x-e[l].rect.x)<op&&r.push(l);if(r.length>=2){let l=r.map(a=>e[a]);l.sort((a,m)=>a.rect.y-m.rect.y);let i=[];for(let a=0;a<l.length-1;a++)i.push(Math.round(l[a+1].rect.y-(l[a].rect.y+l[a].rect.height)));let s=Math.round(l.reduce((a,m)=>a+m.rect.x,0)/l.length);t.push({labels:l.map(a=>a.label),type:"column",sharedEdge:s,gaps:i,avgGap:i.length?Math.round(i.reduce((a,m)=>a+m,0)/i.length):0}),r.forEach(a=>n.add(a))}}return t}function s2(e){if(e.length<2)return[];let t=rp(e.map(i=>({label:i.label,rect:i.originalRect}))),n=rp(e.map(i=>({label:i.label,rect:i.currentRect}))),o=[],r=new Set;for(let i of t){let s=new Set(i.labels),a=null,m=0;for(let p of n){let b=p.labels.filter(y=>s.has(y)).length;b>=2&&b>m&&(a=p,m=b)}if(a){let p=a.labels.filter(y=>s.has(y)),b=p.join(", ");if(a.type!==i.type){let y=i.type==="row"?"y":"x",$=a.type==="row"?"y":"x";o.push(`**${b}**: ${i.type} (${y}\u2248${i.sharedEdge}, ${i.avgGap}px gaps) \u2192 ${a.type} (${$}\u2248${a.sharedEdge}, ${a.avgGap}px gaps)`)}else if(Math.abs(i.sharedEdge-a.sharedEdge)>20||Math.abs(i.avgGap-a.avgGap)>5){let y=i.type==="row"?"y":"x",$=Math.abs(i.sharedEdge-a.sharedEdge)>20?` ${y}: ${i.sharedEdge} \u2192 ${a.sharedEdge}`:"",C=Math.abs(i.avgGap-a.avgGap)>5?` gaps: ${i.avgGap}px \u2192 ${a.avgGap}px`:"";o.push(`**${b}**: ${i.type} shifted \u2014${$}${C}`)}p.forEach(y=>r.add(y))}else{let p=i.labels.join(", "),b=i.type==="row"?"y":"x";o.push(`**${p}**: ${i.type} (${b}\u2248${i.sharedEdge}) dissolved`),i.labels.forEach(y=>r.add(y))}}for(let i of n){if(i.labels.every(m=>r.has(m))||i.labels.filter(m=>!r.has(m)).length<2)continue;if(!t.some(m=>m.labels.filter(b=>i.labels.includes(b)).length>=2)){let m=i.type==="row"?"y":"x";o.push(`**${i.labels.join(", ")}**: new ${i.type} (${m}\u2248${i.sharedEdge}, ${i.avgGap}px gaps)`),i.labels.forEach(p=>r.add(p))}}let l=e.filter(i=>!r.has(i.label));if(l.length>=2){let i={};for(let s of l){let a=Math.round(s.currentRect.x/5)*5;(i[a]??(i[a]=[])).push(s.label)}for(let[s,a]of Object.entries(i))a.length>=2&&o.push(`**${a.join(", ")}**: shared left edge at x\u2248${s}`)}return o}function Ip(e){if(typeof document>"u")return{viewport:e,contentArea:null};let t=[],n=new Set,o=s=>{n.has(s)||s instanceof HTMLElement&&(s.hasAttribute("data-feedback-toolbar")||Iu.has(s.tagName.toLowerCase())||(n.add(s),t.push(s)))},r=document.querySelector("main");r&&o(r);let l=document.querySelector("[role='main']");l&&o(l);for(let s of Array.from(document.body.children))if(o(s),s.children){for(let a of Array.from(s.children))if(o(a),a.children)for(let m of Array.from(a.children))o(m)}let i=null;for(let s of t){let a=s.getBoundingClientRect();if(a.height<50)continue;let m=getComputedStyle(s);if(m.maxWidth&&m.maxWidth!=="none"&&m.maxWidth!=="0px"){(!i||a.width<i.rect.width)&&(i={el:s,rect:a});continue}!i&&a.width<e.width-20&&a.width>100&&(i={el:s,rect:a})}if(i){let{el:s,rect:a}=i;return{viewport:e,contentArea:{width:Math.round(a.width),left:Math.round(a.left),right:Math.round(a.right),centerX:Math.round(a.left+a.width/2),selector:Rr(s)}}}return{viewport:e,contentArea:null}}function a2(e){if(typeof document>"u")return null;let t=document.querySelector(e);if(!t?.parentElement)return null;let n=getComputedStyle(t.parentElement),o={parentDisplay:n.display,parentSelector:Rr(t.parentElement)};return n.display.includes("flex")&&(o.flexDirection=n.flexDirection),n.display.includes("grid")&&n.gridTemplateColumns!=="none"&&(o.gridCols=n.gridTemplateColumns),n.gap&&n.gap!=="normal"&&n.gap!=="0px"&&(o.gap=n.gap),o}function Np(e,t){let n=t.contentArea,o=n?n.width:t.viewport.width,r=n?n.left:0,l=n?n.centerX:Math.round(t.viewport.width/2),i=Math.round(e.x-r),s=Math.round(r+o-(e.x+e.width)),a=(e.width/o*100).toFixed(1),m=e.x+e.width/2,p=Math.abs(m-l)<20,b=e.width/o>.95,y=[];return b?y.push("`width: 100%` of container"):y.push(`left \`${i}px\` in container, right \`${s}px\`, width \`${a}%\` (\`${Math.round(e.width)}px\`)`),p&&!b&&y.push("centered \u2014 `margin-inline: auto`"),y.join(" \u2014 ")}function $p(e){let{viewport:t,contentArea:n}=e,o=`### Reference Frame
`;if(o+=`- Viewport: \`${t.width}\xD7${t.height}px\`
`,n){let r=n;o+=`- Content area: \`${r.width}px\` wide, left edge at \`x=${r.left}\`, right at \`x=${r.right}\` (\`${r.selector}\`)
`,o+=`- Pixel \u2192 CSS translation:
`,o+=`  - **Horizontal position in container**: \`element.x - ${r.left}\` \u2192 use as \`margin-left\` or \`left\`
`,o+=`  - **Width as % of container**: \`element.width / ${r.width} \xD7 100\` \u2192 use as \`width: X%\`
`,o+="  - **Vertical gap between elements**: `nextElement.y - (prevElement.y + prevElement.height)` \u2192 use as `margin-top` or `gap`\n",o+=`  - **Centered**: if \`|element.centerX - ${r.centerX}| < 20px\` \u2192 use \`margin-inline: auto\`
`}else o+=`- No distinct content container \u2014 elements positioned relative to full viewport
`,o+=`- Pixel \u2192 CSS translation:
`,o+=`  - **Width as % of viewport**: \`element.width / ${t.width} \xD7 100\` \u2192 use as \`width: X%\`
`,o+=`  - **Centered**: if \`|(element.x + element.width/2) - ${Math.round(t.width/2)}| < 20px\` \u2192 use \`margin-inline: auto\`
`;return o+=`
`,o}function c2(e){let t=a2(e);if(!t)return null;let n=`\`${t.parentDisplay}\``;return t.flexDirection&&(n+=`, flex-direction: \`${t.flexDirection}\``),t.gridCols&&(n+=`, grid-template-columns: \`${t.gridCols}\``),t.gap&&(n+=`, gap: \`${t.gap}\``),`Parent: ${n} (\`${t.parentSelector}\`)`}function lp(e,t,n,o="standard"){if(e.length===0)return"";let r=[...e].sort((E,f)=>Math.abs(E.y-f.y)<20?E.x-f.x:E.y-f.y),l="";if(n?.blankCanvas?(l+=`## Wireframe: New Page

`,n.wireframePurpose&&(l+=`> **Purpose:** ${n.wireframePurpose}
>
`),l+=`> ${e.length} component${e.length!==1?"s":""} placed \u2014 this is a standalone wireframe, not related to the current page.
>
> This wireframe is a rough sketch for exploring ideas.

`):l+=`## Design Layout

> ${e.length} component${e.length!==1?"s":""} placed

`,o==="compact")return l+=`### Components
`,r.forEach((E,f)=>{let g=Jn[E.type]?.label||E.type;l+=`${f+1}. **${g}** \u2014 \`${Math.round(E.width)}\xD7${Math.round(E.height)}px\` at \`(${Math.round(E.x)}, ${Math.round(E.y)})\`
`}),l;let i=Ip(t);l+=$p(i),l+=`### Components
`,r.forEach((E,f)=>{let g=Jn[E.type]?.label||E.type,w={x:E.x,y:E.y,width:E.width,height:E.height};l+=`${f+1}. **${g}** \u2014 \`${Math.round(E.width)}\xD7${Math.round(E.height)}px\` at \`(${Math.round(E.x)}, ${Math.round(E.y)})\`
`;let N=Nu(w),V=Lp(N,{includeLeftRight:o==="detailed"||o==="forensic"});for(let G of V)l+=`   - ${G}
`;let D=Np(w,i);D&&(l+=`   - CSS: ${D}
`)}),l+=`
### Layout Analysis
`;let s=[];for(let E of r){let f=s.find(g=>Math.abs(g.y-E.y)<30);f?f.items.push(E):s.push({y:E.y,items:[E]})}if(s.sort((E,f)=>E.y-f.y),s.forEach((E,f)=>{E.items.sort((w,N)=>w.x-N.x);let g=E.items.map(w=>Jn[w.type]?.label||w.type);if(E.items.length===1){let N=E.items[0].width>t.width*.8;l+=`- Row ${f+1} (y\u2248${Math.round(E.y)}): ${g[0]}${N?" \u2014 full width":""}
`}else l+=`- Row ${f+1} (y\u2248${Math.round(E.y)}): ${g.join(" | ")} \u2014 ${E.items.length} items side by side
`}),o==="detailed"||o==="forensic"){l+=`
### Spacing & Gaps
`;for(let E=0;E<r.length-1;E++){let f=r[E],g=r[E+1],w=Jn[f.type]?.label||f.type,N=Jn[g.type]?.label||g.type,H=Math.round(g.y-(f.y+f.height)),V=Math.round(g.x-(f.x+f.width));Math.abs(f.y-g.y)<30?l+=`- ${w} \u2192 ${N}: \`${V}px\` horizontal gap
`:l+=`- ${w} \u2192 ${N}: \`${H}px\` vertical gap
`}if(o==="forensic"&&r.length>2){l+=`
### All Pairwise Gaps
`;for(let E=0;E<r.length;E++)for(let f=E+1;f<r.length;f++){let g=r[E],w=r[f],N=Jn[g.type]?.label||g.type,H=Jn[w.type]?.label||w.type,V=Math.round(w.y-(g.y+g.height)),D=Math.round(w.x-(g.x+g.width));l+=`- ${N} \u2194 ${H}: h=\`${D}px\` v=\`${V}px\`
`}}o==="forensic"&&(l+=`
### Z-Order (placement order)
`,e.forEach((E,f)=>{let g=Jn[E.type]?.label||E.type;l+=`${f}. ${g} at \`(${Math.round(E.x)}, ${Math.round(E.y)})\`
`}))}l+=`
### Suggested Implementation
`;let a=r.some(E=>E.type==="navigation"),m=r.some(E=>E.type==="hero"),p=r.some(E=>E.type==="sidebar"),b=r.some(E=>E.type==="footer"),y=r.filter(E=>E.type==="card"),$=r.filter(E=>E.type==="form"),C=r.filter(E=>E.type==="table"),I=r.filter(E=>E.type==="modal");if(a&&(l+=`- Top navigation bar with logo + nav links + CTA
`),m&&(l+=`- Hero section with heading, subtext, and call-to-action
`),p&&(l+=`- Sidebar layout \u2014 use CSS Grid with sidebar + main content area
`),y.length>1?l+=`- ${y.length}-column card grid \u2014 use CSS Grid or Flexbox
`:y.length===1&&(l+=`- Card component with image + content area
`),$.length>0&&(l+=`- ${$.length} form${$.length>1?"s":""} \u2014 add proper labels, validation, and submit handling
`),C.length>0&&(l+=`- Data table \u2014 consider sortable columns and pagination
`),I.length>0&&(l+=`- Modal dialog \u2014 add overlay backdrop and focus trapping
`),b&&(l+=`- Multi-column footer with links
`),o==="detailed"||o==="forensic"){if(l+=`
### CSS Suggestions
`,p){let E=r.find(f=>f.type==="sidebar");l+=`- \`display: grid; grid-template-columns: ${Math.round(E.width)}px 1fr;\`
`}if(y.length>1){let E=Math.round(y[0].width);l+=`- \`display: grid; grid-template-columns: repeat(${y.length}, ${E}px); gap: 16px;\`
`}a&&(l+="- Navigation: `position: sticky; top: 0; z-index: 50;`\n")}return l}function ip(e,t="standard",n){let{sections:o}=e,r=[];for(let p of o){let b=p.originalRect,y=p.currentRect,$=Math.abs(b.x-y.x)>1||Math.abs(b.y-y.y)>1,C=Math.abs(b.width-y.width)>1||Math.abs(b.height-y.height)>1;if(!$&&!C){t==="forensic"&&r.push({section:p,posMoved:!1,sizeChanged:!1});continue}r.push({section:p,posMoved:$,sizeChanged:C})}if(r.length===0||t!=="forensic"&&r.every(p=>!p.posMoved&&!p.sizeChanged))return"";let l=`## Suggested Layout Changes

`,i=n?n.width:typeof window<"u"?window.innerWidth:0,s=n?n.height:typeof window<"u"?window.innerHeight:0,a=Ip({width:i,height:s});t!=="compact"&&(l+=$p(a)),t==="forensic"&&(l+=`> Detected at: \`${new Date(e.detectedAt).toISOString()}\`
`,l+=`> Total sections: ${o.length}

`);let m=p=>o.map(b=>({label:b.label,selector:b.selector,rect:p==="original"?b.originalRect:b.currentRect}));l+=`**Changes:**
`;for(let{section:p,posMoved:b,sizeChanged:y}of r){let $=p.originalRect,C=p.currentRect;if(!b&&!y){l+=`- ${p.label} \u2014 unchanged at (${Math.round(C.x)}, ${Math.round(C.y)}) ${Math.round(C.width)}\xD7${Math.round(C.height)}px
`;continue}if(t==="compact"){b&&y?l+=`- Suggested: move **${p.label}** to (${Math.round(C.x)}, ${Math.round(C.y)}) ${Math.round(C.width)}\xD7${Math.round(C.height)}px
`:b?l+=`- Suggested: move **${p.label}** to (${Math.round(C.x)}, ${Math.round(C.y)})
`:l+=`- Suggested: resize **${p.label}** to ${Math.round(C.width)}\xD7${Math.round(C.height)}px
`;continue}if(b&&y?l+=`- Suggested: move and resize **${p.label}**
`:b?l+=`- Suggested: move **${p.label}**
`:l+=`- Suggested: resize **${p.label}** from ${Math.round($.width)}\xD7${Math.round($.height)}px to ${Math.round(C.width)}\xD7${Math.round(C.height)}px
`,b){let E=Nu($,m("original")),f=Nu(C,m("current")),g=y?{width:$.width,height:$.height}:void 0;l+=`  - Currently ${i2(E,{x:$.x,y:$.y},g)}
`;let w=y?{width:C.width,height:C.height}:void 0,N=`at (${Math.round(C.x)}, ${Math.round(C.y)})`,H=w?`, ${Math.round(w.width)}\xD7${Math.round(w.height)}px`:"",D=Lp(f,{includeLeftRight:t==="detailed"||t==="forensic"});if(D.length>0){l+=`  - Suggested position ${N}${H}: ${D[0]}
`;for(let ye=1;ye<D.length;ye++)l+=`    ${D[ye]}
`}else l+=`  - Suggested position ${N}${H}
`;let G=Np(C,a);G&&(l+=`  - CSS: ${G}
`)}let I=c2(p.selector);if(I&&(l+=`  - ${I}
`),l+=`  - Selector: \`${p.selector}\`
`,t==="detailed"||t==="forensic"){let E=p.className?`${p.tagName}.${p.className.split(" ")[0]}`:p.tagName;E!==p.selector&&(l+=`  - Element: \`${E}\`
`),p.role&&(l+=`  - Role: \`${p.role}\`
`),t==="forensic"&&p.textSnippet&&(l+=`  - Text: "${p.textSnippet}"
`)}t==="forensic"&&(l+=`  - Original rect: \`{ x: ${Math.round($.x)}, y: ${Math.round($.y)}, w: ${Math.round($.width)}, h: ${Math.round($.height)} }\`
`,l+=`  - Current rect: \`{ x: ${Math.round(C.x)}, y: ${Math.round(C.y)}, w: ${Math.round(C.width)}, h: ${Math.round(C.height)} }\`
`)}if(t!=="compact"){let p=r.filter(y=>y.posMoved).map(y=>({label:y.section.label,originalRect:y.section.originalRect,currentRect:y.section.currentRect})),b=s2(p);if(b.length>0){l+=`
### Layout Summary
`;for(let y of b)l+=`- ${y}
`}}if(t!=="compact"&&o.length>1){l+=`
### All Sections (current positions)
`;let p=[...o].sort((b,y)=>Math.abs(b.currentRect.y-y.currentRect.y)<20?b.currentRect.x-y.currentRect.x:b.currentRect.y-y.currentRect.y);for(let b of p){let y=b.currentRect,$=Math.abs(y.x-b.originalRect.x)>1||Math.abs(y.y-b.originalRect.y)>1||Math.abs(y.width-b.originalRect.width)>1||Math.abs(y.height-b.originalRect.height)>1;l+=`- ${b.label}: \`${Math.round(y.width)}\xD7${Math.round(y.height)}px\` at \`(${Math.round(y.x)}, ${Math.round(y.y)})\`${$?" \u2190 suggested":""}
`}}return l}var $u="feedback-annotations-",Rp=7;function Ta(e){return`${$u}${e}`}function gu(e){if(typeof window>"u")return[];try{let t=localStorage.getItem(Ta(e));if(!t)return[];let n=JSON.parse(t),o=Date.now()-Rp*24*60*60*1e3;return n.filter(r=>!r.timestamp||r.timestamp>o)}catch{return[]}}function Tp(e,t){if(!(typeof window>"u"))try{localStorage.setItem(Ta(e),JSON.stringify(t))}catch{}}function d2(){let e=new Map;if(typeof window>"u")return e;try{let t=Date.now()-Rp*24*60*60*1e3;for(let n=0;n<localStorage.length;n++){let o=localStorage.key(n);if(o?.startsWith($u)){let r=o.slice($u.length),l=localStorage.getItem(o);if(l){let s=JSON.parse(l).filter(a=>!a.timestamp||a.timestamp>t);s.length>0&&e.set(r,s)}}}}catch{}return e}function Ni(e,t,n){let o=t.map(r=>({...r,_syncedTo:n}));Tp(e,o)}var Pu="agentation-design-";function u2(e){if(typeof window>"u")return[];try{let t=localStorage.getItem(`${Pu}${e}`);return t?JSON.parse(t):[]}catch{return[]}}function _2(e,t){if(!(typeof window>"u"))try{localStorage.setItem(`${Pu}${e}`,JSON.stringify(t))}catch{}}function f2(e){if(!(typeof window>"u"))try{localStorage.removeItem(`${Pu}${e}`)}catch{}}var Du="agentation-rearrange-";function h2(e){if(typeof window>"u")return null;try{let t=localStorage.getItem(`${Du}${e}`);return t?JSON.parse(t):null}catch{return null}}function p2(e,t){if(!(typeof window>"u"))try{localStorage.setItem(`${Du}${e}`,JSON.stringify(t))}catch{}}function m2(e){if(!(typeof window>"u"))try{localStorage.removeItem(`${Du}${e}`)}catch{}}var Bu="agentation-wireframe-";function g2(e){if(typeof window>"u")return null;try{let t=localStorage.getItem(`${Bu}${e}`);return t?JSON.parse(t):null}catch{return null}}function sp(e,t){if(!(typeof window>"u"))try{localStorage.setItem(`${Bu}${e}`,JSON.stringify(t))}catch{}}function Ea(e){if(!(typeof window>"u"))try{localStorage.removeItem(`${Bu}${e}`)}catch{}}var Pp="agentation-session-";function zu(e){return`${Pp}${e}`}function y2(e){if(typeof window>"u")return null;try{return localStorage.getItem(zu(e))}catch{return null}}function yu(e,t){if(!(typeof window>"u"))try{localStorage.setItem(zu(e),t)}catch{}}function x2(e){if(!(typeof window>"u"))try{localStorage.removeItem(zu(e))}catch{}}var Ru=`${Pp}toolbar-hidden`;function v2(){if(typeof window>"u")return!1;try{return sessionStorage.getItem(Ru)==="1"}catch{return!1}}function w2(e){if(!(typeof window>"u"))try{e?sessionStorage.setItem(Ru,"1"):sessionStorage.removeItem(Ru)}catch{}}async function xu(e,t){let n=await fetch(`${e}/sessions`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:t})});if(!n.ok)throw new Error(`Failed to create session: ${n.status}`);return n.json()}async function ap(e,t){let n=await fetch(`${e}/sessions/${t}`);if(!n.ok)throw new Error(`Failed to get session: ${n.status}`);return n.json()}async function yl(e,t,n){let o=await fetch(`${e}/sessions/${t}/annotations`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(n)});if(!o.ok)throw new Error(`Failed to sync annotation: ${o.status}`);return o.json()}async function cp(e,t,n){let o=await fetch(`${e}/annotations/${t}`,{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify(n)});if(!o.ok)throw new Error(`Failed to update annotation: ${o.status}`);return o.json()}async function or(e,t){let n=await fetch(`${e}/annotations/${t}`,{method:"DELETE"});if(!n.ok)throw new Error(`Failed to delete annotation: ${n.status}`)}var Je={FunctionComponent:0,ClassComponent:1,IndeterminateComponent:2,HostRoot:3,HostPortal:4,HostComponent:5,HostText:6,Fragment:7,Mode:8,ContextConsumer:9,ContextProvider:10,ForwardRef:11,Profiler:12,SuspenseComponent:13,MemoComponent:14,SimpleMemoComponent:15,LazyComponent:16,IncompleteClassComponent:17,DehydratedFragment:18,SuspenseListComponent:19,ScopeComponent:21,OffscreenComponent:22,LegacyHiddenComponent:23,CacheComponent:24,TracingMarkerComponent:25,HostHoistable:26,HostSingleton:27,IncompleteFunctionComponent:28,Throw:29,ViewTransitionComponent:30,ActivityComponent:31},dp=new Set(["Component","PureComponent","Fragment","Suspense","Profiler","StrictMode","Routes","Route","Outlet","Root","ErrorBoundaryHandler","HotReload","Hot"]),up=[/Boundary$/,/BoundaryHandler$/,/Provider$/,/Consumer$/,/^(Inner|Outer)/,/Router$/,/^Client(Page|Segment|Root)/,/^Segment(ViewNode|Node)$/,/^LayoutSegment/,/^Server(Root|Component|Render)/,/^RSC/,/Context$/,/^Hot(Reload)?$/,/^(Dev|React)(Overlay|Tools|Root)/,/Overlay$/,/Handler$/,/^With[A-Z]/,/Wrapper$/,/^Root$/],b2=[/Page$/,/View$/,/Screen$/,/Section$/,/Card$/,/List$/,/Item$/,/Form$/,/Modal$/,/Dialog$/,/Button$/,/Nav$/,/Header$/,/Footer$/,/Layout$/,/Panel$/,/Tab$/,/Menu$/];function k2(e){let t=e?.mode??"filtered",n=dp;if(e?.skipExact){let o=e.skipExact instanceof Set?e.skipExact:new Set(e.skipExact);n=new Set([...dp,...o])}return{maxComponents:e?.maxComponents??6,maxDepth:e?.maxDepth??30,mode:t,skipExact:n,skipPatterns:e?.skipPatterns?[...up,...e.skipPatterns]:up,userPatterns:e?.userPatterns??b2,filter:e?.filter}}function C2(e){return e.replace(/([a-z])([A-Z])/g,"$1-$2").replace(/([A-Z])([A-Z][a-z])/g,"$1-$2").toLowerCase()}function S2(e,t=10){let n=new Set,o=e,r=0;for(;o&&r<t;)o.className&&typeof o.className=="string"&&o.className.split(/\s+/).forEach(l=>{if(l.length>1){let i=l.replace(/[_][a-zA-Z0-9]{5,}.*$/,"").toLowerCase();i.length>1&&n.add(i)}}),o=o.parentElement,r++;return n}function M2(e,t){let n=C2(e);for(let o of t){if(o===n)return!0;let r=n.split("-").filter(i=>i.length>2),l=o.split("-").filter(i=>i.length>2);for(let i of r)for(let s of l)if(i===s||i.includes(s)||s.includes(i))return!0}return!1}function E2(e,t,n,o){if(n.filter)return n.filter(e,t);switch(n.mode){case"all":return!0;case"filtered":return!(n.skipExact.has(e)||n.skipPatterns.some(r=>r.test(e)));case"smart":return n.skipExact.has(e)||n.skipPatterns.some(r=>r.test(e))?!1:!!(o&&M2(e,o)||n.userPatterns.some(r=>r.test(e)));default:return!0}}var xl=null,L2=new WeakMap;function vu(e){return Object.keys(e).some(t=>t.startsWith("__reactFiber$")||t.startsWith("__reactInternalInstance$")||t.startsWith("__reactProps$"))}function I2(){if(xl!==null)return xl;if(typeof document>"u")return!1;if(document.body&&vu(document.body))return xl=!0,!0;let e=["#root","#app","#__next","[data-reactroot]"];for(let t of e){let n=document.querySelector(t);if(n&&vu(n))return xl=!0,!0}if(document.body){for(let t of document.body.children)if(vu(t))return xl=!0,!0}return xl=!1,!1}var $i={map:L2};function N2(e){return Object.keys(e).find(n=>n.startsWith("__reactFiber$")||n.startsWith("__reactInternalInstance$"))||null}function $2(e){let t=N2(e);return t?e[t]:null}function Er(e){return e?e.displayName?e.displayName:e.name?e.name:null:null}function R2(e){let{tag:t,type:n,elementType:o}=e;if(t===Je.HostComponent||t===Je.HostText||t===Je.HostHoistable||t===Je.HostSingleton||t===Je.Fragment||t===Je.Mode||t===Je.Profiler||t===Je.DehydratedFragment||t===Je.HostRoot||t===Je.HostPortal||t===Je.ScopeComponent||t===Je.OffscreenComponent||t===Je.LegacyHiddenComponent||t===Je.CacheComponent||t===Je.TracingMarkerComponent||t===Je.Throw||t===Je.ViewTransitionComponent||t===Je.ActivityComponent)return null;if(t===Je.ForwardRef){let r=o;if(r?.render){let l=Er(r.render);if(l)return l}return r?.displayName?r.displayName:Er(n)}if(t===Je.MemoComponent||t===Je.SimpleMemoComponent){let r=o;if(r?.type){let l=Er(r.type);if(l)return l}return r?.displayName?r.displayName:Er(n)}if(t===Je.ContextProvider){let r=n;return r?._context?.displayName?`${r._context.displayName}.Provider`:null}if(t===Je.ContextConsumer){let r=n;return r?.displayName?`${r.displayName}.Consumer`:null}if(t===Je.LazyComponent){let r=o;return r?._status===1&&r._result?Er(r._result):null}return t===Je.SuspenseComponent||t===Je.SuspenseListComponent?null:t===Je.IncompleteClassComponent||t===Je.IncompleteFunctionComponent||t===Je.FunctionComponent||t===Je.ClassComponent||t===Je.IndeterminateComponent?Er(n):null}function T2(e){return e.length<=2||e.length<=3&&e===e.toLowerCase()}function P2(e,t){let n=k2(t),o=n.mode==="all";if(o){let a=$i.map.get(e);if(a!==void 0)return a}if(!I2()){let a={path:null,components:[]};return o&&$i.map.set(e,a),a}let r=n.mode==="smart"?S2(e):void 0,l=[];try{let a=$2(e),m=0;for(;a&&m<n.maxDepth&&l.length<n.maxComponents;){let p=R2(a);p&&!T2(p)&&E2(p,m,n,r)&&l.push(p),a=a.return,m++}}catch{let a={path:null,components:[]};return o&&$i.map.set(e,a),a}if(l.length===0){let a={path:null,components:[]};return o&&$i.map.set(e,a),a}let s={path:l.slice().reverse().map(a=>`<${a}>`).join(" "),components:l};return o&&$i.map.set(e,s),s}var Ri={FunctionComponent:0,ClassComponent:1,IndeterminateComponent:2,HostRoot:3,HostPortal:4,HostComponent:5,HostText:6,Fragment:7,Mode:8,ContextConsumer:9,ContextProvider:10,ForwardRef:11,Profiler:12,SuspenseComponent:13,MemoComponent:14,SimpleMemoComponent:15,LazyComponent:16};function D2(e){if(!e||typeof e!="object")return null;let t=Object.keys(e),n=t.find(l=>l.startsWith("__reactFiber$"));if(n)return e[n]||null;let o=t.find(l=>l.startsWith("__reactInternalInstance$"));if(o)return e[o]||null;let r=t.find(l=>{if(!l.startsWith("__react"))return!1;let i=e[l];return i&&typeof i=="object"&&"_debugSource"in i});return r&&e[r]||null}function Di(e){if(!e.type||typeof e.type=="string")return null;if(typeof e.type=="object"||typeof e.type=="function"){let t=e.type;if(t.displayName)return t.displayName;if(t.name)return t.name}return null}function B2(e,t=50){let n=e,o=0;for(;n&&o<t;){if(n._debugSource)return{source:n._debugSource,componentName:Di(n)};if(n._debugOwner?._debugSource)return{source:n._debugOwner._debugSource,componentName:Di(n._debugOwner)};n=n.return,o++}return null}function z2(e){let t=e,n=0,o=50;for(;t&&n<o;){let r=t,l=["_debugSource","__source","_source","debugSource"];for(let i of l){let s=r[i];if(s&&typeof s=="object"&&"fileName"in s)return{source:s,componentName:Di(t)}}if(t.memoizedProps){let i=t.memoizedProps;if(i.__source&&typeof i.__source=="object"){let s=i.__source;if(s.fileName&&s.lineNumber)return{source:{fileName:s.fileName,lineNumber:s.lineNumber,columnNumber:s.columnNumber},componentName:Di(t)}}}t=t.return,n++}return null}var La=new Map;function O2(e){let t=e.tag,n=e.type,o=e.elementType;if(typeof n=="string"||n==null||typeof n=="function"&&n.prototype?.isReactComponent)return null;if((t===Ri.FunctionComponent||t===Ri.IndeterminateComponent)&&typeof n=="function")return n;if(t===Ri.ForwardRef&&o){let r=o.render;if(typeof r=="function")return r}if((t===Ri.MemoComponent||t===Ri.SimpleMemoComponent)&&o){let r=o.type;if(typeof r=="function")return r}return typeof n=="function"?n:null}function A2(){let e=Dp.default,t=e.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;if(t&&"H"in t)return{get:()=>t.H,set:o=>{t.H=o}};let n=e.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;if(n){let o=n.ReactCurrentDispatcher;if(o&&"current"in o)return{get:()=>o.current,set:r=>{o.current=r}}}return null}function W2(e){let t=e.split(`
`),n=[/source-location/,/\/dist\/index\./,/node_modules\//,/react-dom/,/react\.development/,/react\.production/,/chunk-[A-Z0-9]+/i,/react-stack-bottom-frame/,/react-reconciler/,/scheduler/,/<anonymous>/],o=/^\s*at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?$/,r=/^[^@]*@(.+?):(\d+):(\d+)$/;for(let l of t){let i=l.trim();if(!i||n.some(a=>a.test(i)))continue;let s=o.exec(i)||r.exec(i);if(s)return{fileName:s[1],line:parseInt(s[2],10),column:parseInt(s[3],10)}}return null}function F2(e){let t=e;return t=t.replace(/[?#].*$/,""),t=t.replace(/^turbopack:\/\/\/\[project\]\//,""),t=t.replace(/^webpack-internal:\/\/\/\.\//,""),t=t.replace(/^webpack-internal:\/\/\//,""),t=t.replace(/^webpack:\/\/\/\.\//,""),t=t.replace(/^webpack:\/\/\//,""),t=t.replace(/^turbopack:\/\/\//,""),t=t.replace(/^https?:\/\/[^/]+\//,""),t=t.replace(/^file:\/\/\//,"/"),t=t.replace(/^\([^)]+\)\/\.\//,""),t=t.replace(/^\.\//,""),t}function j2(e){let t=O2(e);if(!t)return null;if(La.has(t))return La.get(t);let n=A2();if(!n)return La.set(t,null),null;let o=n.get(),r=null;try{let l=new Proxy({},{get(){throw new Error("probe")}});n.set(l);try{t({})}catch(i){if(i instanceof Error&&i.message==="probe"&&i.stack){let s=W2(i.stack);s&&(r={fileName:F2(s.fileName),lineNumber:s.line,columnNumber:s.column,componentName:Di(e)||void 0})}}}finally{n.set(o)}return La.set(t,r),r}function H2(e,t=15){let n=e,o=0;for(;n&&o<t;){let r=j2(n);if(r)return r;n=n.return,o++}return null}function Tu(e){let t=D2(e);if(!t)return{found:!1,reason:"no-fiber",isReactApp:!1,isProduction:!1};let n=B2(t);if(n||(n=z2(t)),n?.source)return{found:!0,source:{fileName:n.source.fileName,lineNumber:n.source.lineNumber,columnNumber:n.source.columnNumber,componentName:n.componentName||void 0},isReactApp:!0,isProduction:!1};let o=H2(t);return o?{found:!0,source:o,isReactApp:!0,isProduction:!1}:{found:!1,reason:"no-debug-source",isReactApp:!0,isProduction:!1}}function U2(e,t="path"){let{fileName:n,lineNumber:o,columnNumber:r}=e,l=`${n}:${o}`;return r!==void 0&&(l+=`:${r}`),t==="vscode"?`vscode://file${n.startsWith("/")?"":"/"}${l}`:l}function Y2(e,t=10){let n=e,o=0;for(;n&&o<t;){let r=Tu(n);if(r.found)return r;n=n.parentElement,o++}return Tu(e)}var X2=`.styles-module__toolbar___wNsdK svg[fill=none],
.styles-module__markersLayer___-25j1 svg[fill=none],
.styles-module__fixedMarkersLayer___ffyX6 svg[fill=none] {
  fill: none !important;
}
.styles-module__toolbar___wNsdK svg[fill=none] :not([fill]),
.styles-module__markersLayer___-25j1 svg[fill=none] :not([fill]),
.styles-module__fixedMarkersLayer___ffyX6 svg[fill=none] :not([fill]) {
  fill: none !important;
}

.styles-module__controlsContent___9GJWU :where(button, input, select, textarea, label) {
  background: unset;
  border: unset;
  border-radius: unset;
  padding: unset;
  margin: unset;
  color: unset;
  font-family: unset;
  font-weight: unset;
  font-style: unset;
  line-height: unset;
  letter-spacing: unset;
  text-transform: unset;
  text-decoration: unset;
  box-shadow: unset;
  outline: unset;
}

@keyframes styles-module__toolbarEnter___u8RRu {
  from {
    opacity: 0;
    transform: scale(0.5) rotate(90deg);
  }
  to {
    opacity: 1;
    transform: scale(1) rotate(0deg);
  }
}
@keyframes styles-module__toolbarHide___y8kaT {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.8);
  }
}
@keyframes styles-module__badgeEnter___mVQLj {
  from {
    opacity: 0;
    transform: scale(0);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes styles-module__scaleIn___c-r1K {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes styles-module__scaleOut___Wctwz {
  from {
    opacity: 1;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(0.85);
  }
}
@keyframes styles-module__slideUp___kgD36 {
  from {
    opacity: 0;
    transform: scale(0.85) translateY(8px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
@keyframes styles-module__slideDown___zcdje {
  from {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
  to {
    opacity: 0;
    transform: scale(0.85) translateY(8px);
  }
}
@keyframes styles-module__fadeIn___b9qmf {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
@keyframes styles-module__fadeOut___6Ut6- {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
@keyframes styles-module__hoverHighlightIn___6WYHY {
  from {
    opacity: 0;
    transform: scale(0.98);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes styles-module__hoverTooltipIn___FYGQx {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(4px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}
.styles-module__disableTransitions___EopxO :is(*, *::before, *::after) {
  transition: none !important;
}

.styles-module__toolbar___wNsdK {
  position: fixed;
  bottom: 1.25rem;
  right: 1.25rem;
  width: 337px;
  z-index: 100000;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  pointer-events: none;
  transition: left 0s, top 0s, right 0s, bottom 0s;
}

:where(.styles-module__toolbar___wNsdK) {
  bottom: 1.25rem;
  right: 1.25rem;
}

.styles-module__toolbarContainer___dIhma {
  position: relative;
  user-select: none;
  margin-left: auto;
  align-self: flex-end;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1a1a1a;
  color: #fff;
  border: none;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2), 0 4px 16px rgba(0, 0, 0, 0.1);
  pointer-events: auto;
  transition: width 0.4s cubic-bezier(0.19, 1, 0.22, 1), transform 0.4s cubic-bezier(0.19, 1, 0.22, 1);
}
.styles-module__toolbarContainer___dIhma.styles-module__entrance___sgHd8 {
  animation: styles-module__toolbarEnter___u8RRu 0.5s cubic-bezier(0.34, 1.2, 0.64, 1) forwards;
}
.styles-module__toolbarContainer___dIhma.styles-module__hiding___1td44 {
  animation: styles-module__toolbarHide___y8kaT 0.4s cubic-bezier(0.4, 0, 1, 1) forwards;
  pointer-events: none;
}
.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn {
  width: 44px;
  height: 44px;
  border-radius: 22px;
  padding: 0;
  cursor: pointer;
}
.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn svg {
  margin-top: -1px;
}
.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:hover {
  background: #2a2a2a;
}
.styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:active {
  transform: scale(0.95);
}
.styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx {
  height: 44px;
  border-radius: 1.5rem;
  padding: 0.375rem;
  width: 297px;
}
.styles-module__toolbarContainer___dIhma.styles-module__expanded___ofKPx.styles-module__serverConnected___Gfbou {
  width: 337px;
}

.styles-module__toggleContent___0yfyP {
  position: absolute;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: opacity 0.1s cubic-bezier(0.19, 1, 0.22, 1);
}
.styles-module__toggleContent___0yfyP.styles-module__visible___KHwEW {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
}
.styles-module__toggleContent___0yfyP.styles-module__hidden___Ae8H4 {
  opacity: 0;
  pointer-events: none;
}

.styles-module__controlsContent___9GJWU {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  transition: filter 0.8s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.8s cubic-bezier(0.19, 1, 0.22, 1), transform 0.6s cubic-bezier(0.19, 1, 0.22, 1);
}
.styles-module__controlsContent___9GJWU.styles-module__visible___KHwEW {
  opacity: 1;
  filter: blur(0px);
  transform: scale(1);
  visibility: visible;
  pointer-events: auto;
}
.styles-module__controlsContent___9GJWU.styles-module__hidden___Ae8H4 {
  pointer-events: none;
  opacity: 0;
  filter: blur(10px);
  transform: scale(0.4);
}

.styles-module__badge___2XsgF {
  position: absolute;
  top: -13px;
  right: -13px;
  user-select: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background-color: var(--agentation-color-accent);
  color: white;
  font-size: 0.625rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15), inset 0 0 0 1px rgba(255, 255, 255, 0.04);
  opacity: 1;
  transition: transform 0.3s ease, opacity 0.2s ease;
  transform: scale(1);
}
.styles-module__badge___2XsgF.styles-module__fadeOut___6Ut6- {
  opacity: 0;
  transform: scale(0);
  pointer-events: none;
}
.styles-module__badge___2XsgF.styles-module__entrance___sgHd8 {
  animation: styles-module__badgeEnter___mVQLj 0.3s cubic-bezier(0.34, 1.2, 0.64, 1) 0.4s both;
}

.styles-module__controlButton___8Q0jc {
  position: relative;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: none;
  background: transparent;
  color: rgba(255, 255, 255, 0.85);
  transition: background-color 0.15s ease, color 0.15s ease, transform 0.1s ease, opacity 0.2s ease;
}
.styles-module__controlButton___8Q0jc:hover:not(:disabled):not([data-active=true]):not([data-failed=true]):not([data-auto-sync=true]):not([data-error=true]):not([data-no-hover=true]) {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
}
.styles-module__controlButton___8Q0jc:active:not(:disabled) {
  transform: scale(0.92);
}
.styles-module__controlButton___8Q0jc:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.styles-module__controlButton___8Q0jc[data-active=true] {
  color: var(--agentation-color-blue);
  background-color: color-mix(in srgb, var(--agentation-color-blue) 25%, transparent);
}
.styles-module__controlButton___8Q0jc[data-error=true] {
  color: var(--agentation-color-red);
  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);
}
.styles-module__controlButton___8Q0jc[data-danger]:hover:not(:disabled):not([data-active=true]):not([data-failed=true]) {
  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);
  color: var(--agentation-color-red);
}
.styles-module__controlButton___8Q0jc[data-no-hover=true], .styles-module__controlButton___8Q0jc.styles-module__statusShowing___te6iu {
  cursor: default;
  pointer-events: none;
  background: transparent !important;
}
.styles-module__controlButton___8Q0jc[data-auto-sync=true] {
  color: var(--agentation-color-green);
  background: transparent;
  cursor: default;
}
.styles-module__controlButton___8Q0jc[data-failed=true] {
  color: var(--agentation-color-red);
  background-color: color-mix(in srgb, var(--agentation-color-red) 25%, transparent);
}

.styles-module__buttonBadge___NeFWb {
  position: absolute;
  top: 0px;
  right: 0px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 8px;
  background-color: var(--agentation-color-accent);
  color: white;
  font-size: 0.625rem;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 2px #1a1a1a, 0 1px 3px rgba(0, 0, 0, 0.2);
  pointer-events: none;
}
[data-agentation-theme=light] .styles-module__buttonBadge___NeFWb {
  box-shadow: 0 0 0 2px #fff, 0 1px 3px rgba(0, 0, 0, 0.2);
}

@keyframes styles-module__mcpIndicatorPulseConnected___EDodZ {
  0%, 100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);
  }
}
@keyframes styles-module__mcpIndicatorPulseConnecting___cCYte {
  0%, 100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-yellow) 50%, transparent);
  }
  50% {
    box-shadow: 0 0 0 5px color-mix(in srgb, var(--agentation-color-yellow) 0%, transparent);
  }
}
.styles-module__mcpIndicator___zGJeL {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  pointer-events: none;
  transition: background-color 0.3s ease, opacity 0.15s ease, transform 0.15s ease;
  opacity: 1;
  transform: scale(1);
}
.styles-module__mcpIndicator___zGJeL.styles-module__connected___7c28g {
  background-color: var(--agentation-color-green);
  animation: styles-module__mcpIndicatorPulseConnected___EDodZ 2.5s ease-in-out infinite;
}
.styles-module__mcpIndicator___zGJeL.styles-module__connecting___uo-CW {
  background-color: var(--agentation-color-yellow);
  animation: styles-module__mcpIndicatorPulseConnecting___cCYte 1.5s ease-in-out infinite;
}
.styles-module__mcpIndicator___zGJeL.styles-module__hidden___Ae8H4 {
  opacity: 0;
  transform: scale(0);
  animation: none;
}

@keyframes styles-module__connectionPulse___-Zycw {
  0%, 100% {
    opacity: 1;
    transform: scale(1);
  }
  50% {
    opacity: 0.6;
    transform: scale(0.9);
  }
}
.styles-module__connectionIndicatorWrapper___L-e-3 {
  width: 8px;
  height: 34px;
  margin-left: 6px;
  margin-right: 6px;
}

.styles-module__connectionIndicator___afk9p {
  position: relative;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  opacity: 0;
  transition: opacity 0.3s ease, background-color 0.3s ease;
  cursor: default;
}

.styles-module__connectionIndicatorVisible___C-i5B {
  opacity: 1;
}

.styles-module__connectionIndicatorConnected___IY8pR {
  background-color: var(--agentation-color-green);
  animation: styles-module__connectionPulse___-Zycw 2.5s ease-in-out infinite;
}

.styles-module__connectionIndicatorDisconnected___kmpaZ {
  background-color: var(--agentation-color-red);
  animation: none;
}

.styles-module__connectionIndicatorConnecting___QmSLH {
  background-color: var(--agentation-color-yellow);
  animation: styles-module__connectionPulse___-Zycw 1s ease-in-out infinite;
}

.styles-module__buttonWrapper___rBcdv {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {
  opacity: 1;
  visibility: visible;
  transform: translateX(-50%) scale(1);
  transition-delay: 0.85s;
}
.styles-module__buttonWrapper___rBcdv:has(.styles-module__controlButton___8Q0jc:disabled):hover .styles-module__buttonTooltip___Burd9 {
  opacity: 0;
  visibility: hidden;
}

.styles-module__tooltipsInSession___-0lHH .styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {
  transition-delay: 0s;
}

.styles-module__sendButtonWrapper___UUxG6 {
  width: 0;
  opacity: 0;
  overflow: hidden;
  pointer-events: none;
  margin-left: -0.375rem;
  transition: width 0.4s cubic-bezier(0.19, 1, 0.22, 1), opacity 0.3s cubic-bezier(0.19, 1, 0.22, 1), margin 0.4s cubic-bezier(0.19, 1, 0.22, 1);
}
.styles-module__sendButtonWrapper___UUxG6 .styles-module__controlButton___8Q0jc {
  transform: scale(0.8);
  transition: transform 0.4s cubic-bezier(0.19, 1, 0.22, 1);
}
.styles-module__sendButtonWrapper___UUxG6.styles-module__sendButtonVisible___WPSQU {
  width: 34px;
  opacity: 1;
  overflow: visible;
  pointer-events: auto;
  margin-left: 0;
}
.styles-module__sendButtonWrapper___UUxG6.styles-module__sendButtonVisible___WPSQU .styles-module__controlButton___8Q0jc {
  transform: scale(1);
}

.styles-module__buttonTooltip___Burd9 {
  position: absolute;
  bottom: calc(100% + 14px);
  left: 50%;
  transform: translateX(-50%) scale(0.95);
  padding: 6px 10px;
  background: #1a1a1a;
  color: rgba(255, 255, 255, 0.9);
  font-size: 12px;
  font-weight: 500;
  border-radius: 8px;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  z-index: 100001;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
  transition: opacity 0.135s ease, transform 0.135s ease, visibility 0.135s ease;
}
.styles-module__buttonTooltip___Burd9::after {
  content: "";
  position: absolute;
  top: calc(100% - 4px);
  left: 50%;
  transform: translateX(-50%) rotate(45deg);
  width: 8px;
  height: 8px;
  background: #1a1a1a;
  border-radius: 0 0 2px 0;
}

.styles-module__shortcut___lEAQk {
  margin-left: 4px;
  opacity: 0.5;
}

.styles-module__tooltipBelow___m6ats .styles-module__buttonTooltip___Burd9 {
  bottom: auto;
  top: calc(100% + 14px);
  transform: translateX(-50%) scale(0.95);
}
.styles-module__tooltipBelow___m6ats .styles-module__buttonTooltip___Burd9::after {
  top: -4px;
  bottom: auto;
  border-radius: 2px 0 0 0;
}

.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapper___rBcdv:hover .styles-module__buttonTooltip___Burd9 {
  transform: translateX(-50%) scale(1);
}

.styles-module__tooltipsHidden___VtLJG .styles-module__buttonTooltip___Burd9 {
  opacity: 0 !important;
  visibility: hidden !important;
  transition: none !important;
}

.styles-module__tooltipVisible___0jcCv,
.styles-module__tooltipsHidden___VtLJG .styles-module__tooltipVisible___0jcCv {
  opacity: 1 !important;
  visibility: visible !important;
  transform: translateX(-50%) scale(1) !important;
  transition-delay: 0s !important;
}

.styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9 {
  left: 50%;
  transform: translateX(-12px) scale(0.95);
}
.styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9::after {
  left: 16px;
}
.styles-module__buttonWrapperAlignLeft___myzIp:hover .styles-module__buttonTooltip___Burd9 {
  transform: translateX(-12px) scale(1);
}

.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignLeft___myzIp .styles-module__buttonTooltip___Burd9 {
  transform: translateX(-12px) scale(0.95);
}
.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignLeft___myzIp:hover .styles-module__buttonTooltip___Burd9 {
  transform: translateX(-12px) scale(1);
}

.styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9 {
  left: 50%;
  transform: translateX(calc(-100% + 12px)) scale(0.95);
}
.styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9::after {
  left: auto;
  right: 8px;
}
.styles-module__buttonWrapperAlignRight___HCQFR:hover .styles-module__buttonTooltip___Burd9 {
  transform: translateX(calc(-100% + 12px)) scale(1);
}

.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignRight___HCQFR .styles-module__buttonTooltip___Burd9 {
  transform: translateX(calc(-100% + 12px)) scale(0.95);
}
.styles-module__tooltipBelow___m6ats .styles-module__buttonWrapperAlignRight___HCQFR:hover .styles-module__buttonTooltip___Burd9 {
  transform: translateX(calc(-100% + 12px)) scale(1);
}

.styles-module__divider___c--s1 {
  width: 1px;
  height: 12px;
  background: rgba(255, 255, 255, 0.15);
  margin: 0 0.125rem;
}

.styles-module__overlay___Q1O9y {
  position: fixed;
  inset: 0;
  z-index: 99997;
  pointer-events: none;
}
.styles-module__overlay___Q1O9y > * {
  pointer-events: auto;
}

.styles-module__hoverHighlight___ogakW {
  position: fixed;
  border: 2px solid color-mix(in srgb, var(--agentation-color-accent) 50%, transparent);
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--agentation-color-accent) 4%, transparent);
  pointer-events: none !important;
  box-sizing: border-box;
  will-change: opacity;
  contain: layout style;
}
.styles-module__hoverHighlight___ogakW.styles-module__enter___WFIki {
  animation: styles-module__hoverHighlightIn___6WYHY 0.12s ease-out forwards;
}

.styles-module__multiSelectOutline___cSJ-m {
  position: fixed;
  border: 2px dashed color-mix(in srgb, var(--agentation-color-green) 60%, transparent);
  border-radius: 4px;
  pointer-events: none !important;
  background-color: color-mix(in srgb, var(--agentation-color-green) 5%, transparent);
  box-sizing: border-box;
  will-change: opacity;
}
.styles-module__multiSelectOutline___cSJ-m.styles-module__enter___WFIki {
  animation: styles-module__fadeIn___b9qmf 0.15s ease-out forwards;
}
.styles-module__multiSelectOutline___cSJ-m.styles-module__exit___fyOJ0 {
  animation: styles-module__fadeOut___6Ut6- 0.15s ease-out forwards;
}

.styles-module__singleSelectOutline___QhX-O {
  position: fixed;
  border: 2px solid color-mix(in srgb, var(--agentation-color-blue) 60%, transparent);
  border-radius: 4px;
  pointer-events: none !important;
  background-color: color-mix(in srgb, var(--agentation-color-blue) 5%, transparent);
  box-sizing: border-box;
  will-change: opacity;
}
.styles-module__singleSelectOutline___QhX-O.styles-module__enter___WFIki {
  animation: styles-module__fadeIn___b9qmf 0.15s ease-out forwards;
}
.styles-module__singleSelectOutline___QhX-O.styles-module__exit___fyOJ0 {
  animation: styles-module__fadeOut___6Ut6- 0.15s ease-out forwards;
}

.styles-module__hoverTooltip___bvLk7 {
  position: fixed;
  font-size: 0.6875rem;
  font-weight: 500;
  color: #fff;
  background: rgba(0, 0, 0, 0.85);
  padding: 0.35rem 0.6rem;
  border-radius: 0.375rem;
  pointer-events: none !important;
  white-space: nowrap;
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.styles-module__hoverTooltip___bvLk7.styles-module__enter___WFIki {
  animation: styles-module__hoverTooltipIn___FYGQx 0.1s ease-out forwards;
}

.styles-module__hoverReactPath___gx1IJ {
  font-size: 0.625rem;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 0.15rem;
  overflow: hidden;
  text-overflow: ellipsis;
}

.styles-module__hoverElementName___QMLMl {
  overflow: hidden;
  text-overflow: ellipsis;
}

.styles-module__markersLayer___-25j1 {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 0;
  z-index: 99998;
  pointer-events: none;
}
.styles-module__markersLayer___-25j1 > * {
  pointer-events: auto;
}

.styles-module__fixedMarkersLayer___ffyX6 {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 99998;
  pointer-events: none;
}
.styles-module__fixedMarkersLayer___ffyX6 > * {
  pointer-events: auto;
}

.styles-module__marker___6sQrs {
  position: absolute;
  width: 22px;
  height: 22px;
  background: var(--agentation-color-blue);
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 600;
  transform: translate(-50%, -50%) scale(1);
  opacity: 1;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04);
  user-select: none;
  will-change: transform, opacity;
  contain: layout style;
  z-index: 1;
}
.styles-module__marker___6sQrs:hover {
  z-index: 2;
}
.styles-module__marker___6sQrs:not(.styles-module__enter___WFIki):not(.styles-module__exit___fyOJ0):not(.styles-module__clearing___FQ--7) {
  transition: background-color 0.15s ease, transform 0.1s ease;
}
.styles-module__marker___6sQrs.styles-module__enter___WFIki {
  animation: styles-module__markerIn___5FaAP 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.styles-module__marker___6sQrs.styles-module__exit___fyOJ0 {
  animation: styles-module__markerOut___GU5jX 0.2s ease-out both;
  pointer-events: none;
}
.styles-module__marker___6sQrs.styles-module__clearing___FQ--7 {
  animation: styles-module__markerOut___GU5jX 0.15s ease-out both;
  pointer-events: none;
}
.styles-module__marker___6sQrs:not(.styles-module__enter___WFIki):not(.styles-module__exit___fyOJ0):not(.styles-module__clearing___FQ--7):hover {
  transform: translate(-50%, -50%) scale(1.1);
}
.styles-module__marker___6sQrs.styles-module__pending___2IHLC {
  position: fixed;
  background-color: var(--agentation-color-blue);
  cursor: default;
}
.styles-module__marker___6sQrs.styles-module__fixed___dBMHC {
  position: fixed;
}
.styles-module__marker___6sQrs.styles-module__multiSelect___YWiuz {
  background-color: var(--agentation-color-green);
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 0.75rem;
}
.styles-module__marker___6sQrs.styles-module__multiSelect___YWiuz.styles-module__pending___2IHLC {
  background-color: var(--agentation-color-green);
}
.styles-module__marker___6sQrs.styles-module__hovered___ZgXIy {
  background-color: var(--agentation-color-red);
}

.styles-module__renumber___nCTxD {
  display: block;
  animation: styles-module__renumberRoll___Wgbq3 0.2s ease-out;
}

@keyframes styles-module__renumberRoll___Wgbq3 {
  0% {
    transform: translateX(-40%);
    opacity: 0;
  }
  100% {
    transform: translateX(0);
    opacity: 1;
  }
}
.styles-module__markerTooltip___aLJID {
  position: absolute;
  top: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%) scale(0.909);
  z-index: 100002;
  background: #1a1a1a;
  padding: 8px 0.75rem;
  border-radius: 0.75rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-weight: 400;
  color: #fff;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);
  min-width: 120px;
  max-width: 200px;
  pointer-events: none;
  cursor: default;
}
.styles-module__markerTooltip___aLJID.styles-module__enter___WFIki {
  animation: styles-module__tooltipIn___0N31w 0.1s ease-out forwards;
}

.styles-module__markerQuote___FHmrz {
  display: block;
  font-size: 12px;
  font-style: italic;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 0.3125rem;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.styles-module__markerNote___QkrrS {
  display: block;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-bottom: 2px;
}

.styles-module__markerHint___2iF-6 {
  display: block;
  font-size: 0.625rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.6);
  margin-top: 0.375rem;
  white-space: nowrap;
}

.styles-module__settingsPanel___OxX3Y {
  position: absolute;
  right: 5px;
  bottom: calc(100% + 0.5rem);
  z-index: 1;
  overflow: hidden;
  background: #1c1c1c;
  border-radius: 1rem;
  padding: 13px 0 16px;
  min-width: 205px;
  cursor: default;
  opacity: 1;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);
  transition: background-color 0.25s ease, box-shadow 0.25s ease;
}
.styles-module__settingsPanel___OxX3Y::before, .styles-module__settingsPanel___OxX3Y::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 16px;
  z-index: 2;
  pointer-events: none;
}
.styles-module__settingsPanel___OxX3Y::before {
  left: 0;
  background: linear-gradient(to right, #1c1c1c 0%, transparent 100%);
}
.styles-module__settingsPanel___OxX3Y::after {
  right: 0;
  background: linear-gradient(to left, #1c1c1c 0%, transparent 100%);
}
.styles-module__settingsPanel___OxX3Y .styles-module__settingsHeader___pwDY9,
.styles-module__settingsPanel___OxX3Y .styles-module__settingsBrand___0gJeM,
.styles-module__settingsPanel___OxX3Y .styles-module__settingsBrandSlash___uTG18,
.styles-module__settingsPanel___OxX3Y .styles-module__settingsVersion___TUcFq,
.styles-module__settingsPanel___OxX3Y .styles-module__settingsSection___m-YM2,
.styles-module__settingsPanel___OxX3Y .styles-module__settingsLabel___8UjfX,
.styles-module__settingsPanel___OxX3Y .styles-module__cycleButton___FMKfw,
.styles-module__settingsPanel___OxX3Y .styles-module__cycleDot___nPgLY,
.styles-module__settingsPanel___OxX3Y .styles-module__dropdownButton___16NPz,
.styles-module__settingsPanel___OxX3Y .styles-module__toggleLabel___Xm8Aa,
.styles-module__settingsPanel___OxX3Y .styles-module__customCheckbox___U39ax,
.styles-module__settingsPanel___OxX3Y .styles-module__sliderLabel___U8sPr,
.styles-module__settingsPanel___OxX3Y .styles-module__slider___GLdxp,
.styles-module__settingsPanel___OxX3Y .styles-module__themeToggle___2rUjA {
  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;
}
.styles-module__settingsPanel___OxX3Y.styles-module__enter___WFIki {
  opacity: 1;
  transform: translateY(0) scale(1);
  filter: blur(0px);
  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;
}
.styles-module__settingsPanel___OxX3Y.styles-module__exit___fyOJ0 {
  opacity: 0;
  transform: translateY(8px) scale(0.95);
  filter: blur(5px);
  pointer-events: none;
  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;
}
[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y {
  background: #1a1a1a;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsLabel___8UjfX {
  color: rgba(255, 255, 255, 0.6);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12 {
  color: rgba(255, 255, 255, 0.85);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12:hover {
  background: rgba(255, 255, 255, 0.1);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__settingsOption___UNa12.styles-module__selected___OwRqP {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}
[data-agentation-theme=dark] .styles-module__settingsPanel___OxX3Y .styles-module__toggleLabel___Xm8Aa {
  color: rgba(255, 255, 255, 0.85);
}

.styles-module__settingsPanelContainer___Xksv8 {
  overflow: visible;
  position: relative;
  display: flex;
  padding: 0 1rem;
}

.styles-module__settingsPage___6YfHH {
  min-width: 100%;
  flex-shrink: 0;
  transition: transform 0.2s ease, opacity 0.2s ease;
  transition-delay: 0s;
  opacity: 1;
}

.styles-module__settingsPage___6YfHH.styles-module__slideLeft___Ps01J {
  transform: translateX(-24px);
  opacity: 0;
  pointer-events: none;
}

.styles-module__automationsPage___uvCq6 {
  position: absolute;
  top: 0;
  left: 24px;
  width: 100%;
  height: 100%;
  padding: 3px 1rem 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  transition: transform 0.2s ease, opacity 0.2s ease;
  opacity: 0;
  pointer-events: none;
}

.styles-module__automationsPage___uvCq6.styles-module__slideIn___4-qXe {
  transform: translateX(-24px);
  opacity: 1;
  pointer-events: auto;
}

.styles-module__settingsNavLink___wCzJt {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
  cursor: pointer;
  transition: color 0.15s ease;
}
.styles-module__settingsNavLink___wCzJt:hover {
  color: rgba(255, 255, 255, 0.9);
}
[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt {
  color: rgba(0, 0, 0, 0.5);
}
[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt:hover {
  color: rgba(0, 0, 0, 0.8);
}
.styles-module__settingsNavLink___wCzJt svg {
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.15s ease;
}
.styles-module__settingsNavLink___wCzJt:hover svg {
  color: #fff;
}
[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt svg {
  color: rgba(0, 0, 0, 0.25);
}
[data-agentation-theme=light] .styles-module__settingsNavLink___wCzJt:hover svg {
  color: rgba(0, 0, 0, 0.8);
}

.styles-module__settingsNavLinkRight___ZWwhj {
  display: flex;
  align-items: center;
  gap: 6px;
}

.styles-module__mcpNavIndicator___cl9pO {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.styles-module__mcpNavIndicator___cl9pO.styles-module__connected___7c28g {
  background-color: var(--agentation-color-green);
  animation: styles-module__mcpPulse___uNggr 2.5s ease-in-out infinite;
}
.styles-module__mcpNavIndicator___cl9pO.styles-module__connecting___uo-CW {
  background-color: var(--agentation-color-yellow);
  animation: styles-module__mcpPulse___uNggr 1.5s ease-in-out infinite;
}

.styles-module__settingsBackButton___bIe2j {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 0 12px 0;
  margin: -6px 0 0.5rem 0;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 0;
  background: transparent;
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  letter-spacing: -0.15px;
  color: #fff;
  cursor: pointer;
  transition: transform 0.12s cubic-bezier(0.32, 0.72, 0, 1);
}
.styles-module__settingsBackButton___bIe2j svg {
  opacity: 0.4;
  flex-shrink: 0;
  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}
.styles-module__settingsBackButton___bIe2j:hover {
  border-bottom-color: rgba(255, 255, 255, 0.07);
}
.styles-module__settingsBackButton___bIe2j:hover svg {
  opacity: 1;
}
[data-agentation-theme=light] .styles-module__settingsBackButton___bIe2j {
  color: rgba(0, 0, 0, 0.85);
  border-bottom-color: rgba(0, 0, 0, 0.08);
}
[data-agentation-theme=light] .styles-module__settingsBackButton___bIe2j:hover {
  border-bottom-color: rgba(0, 0, 0, 0.08);
}

.styles-module__automationHeader___InP0r {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  font-size: 0.8125rem;
  font-weight: 400;
  color: #fff;
}
[data-agentation-theme=light] .styles-module__automationHeader___InP0r {
  color: rgba(0, 0, 0, 0.85);
}

.styles-module__automationDescription___NKlmo {
  font-size: 0.6875rem;
  font-weight: 300;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 2px;
  line-height: 14px;
}
[data-agentation-theme=light] .styles-module__automationDescription___NKlmo {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__learnMoreLink___8xv-x {
  color: rgba(255, 255, 255, 0.8);
  text-decoration: underline dotted;
  text-decoration-color: rgba(255, 255, 255, 0.2);
  text-underline-offset: 2px;
  transition: color 0.15s ease;
}
.styles-module__learnMoreLink___8xv-x:hover {
  color: #fff;
}
[data-agentation-theme=light] .styles-module__learnMoreLink___8xv-x {
  color: rgba(0, 0, 0, 0.6);
  text-decoration-color: rgba(0, 0, 0, 0.2);
}
[data-agentation-theme=light] .styles-module__learnMoreLink___8xv-x:hover {
  color: rgba(0, 0, 0, 0.85);
}

.styles-module__autoSendRow___UblX5 {
  display: flex;
  align-items: center;
  gap: 8px;
}

.styles-module__autoSendLabel___icDc2 {
  font-size: 0.6875rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.15s ease;
}
.styles-module__autoSendLabel___icDc2.styles-module__active___-zoN6 {
  color: #66b8ff;
  color: color(display-p3 0.4 0.72 1);
}
[data-agentation-theme=light] .styles-module__autoSendLabel___icDc2 {
  color: rgba(0, 0, 0, 0.4);
}
[data-agentation-theme=light] .styles-module__autoSendLabel___icDc2.styles-module__active___-zoN6 {
  color: var(--agentation-color-blue);
}

.styles-module__webhookUrlInput___2375C {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 60px;
  box-sizing: border-box;
  margin-top: 11px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 400;
  color: #fff;
  outline: none;
  resize: none;
  user-select: text;
  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}
.styles-module__webhookUrlInput___2375C::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
.styles-module__webhookUrlInput___2375C:focus {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.08);
}
[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C {
  border-color: rgba(0, 0, 0, 0.1);
  background: rgba(0, 0, 0, 0.03);
  color: rgba(0, 0, 0, 0.85);
}
[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C::placeholder {
  color: rgba(0, 0, 0, 0.3);
}
[data-agentation-theme=light] .styles-module__webhookUrlInput___2375C:focus {
  border-color: rgba(0, 0, 0, 0.25);
  background: rgba(0, 0, 0, 0.05);
}

.styles-module__settingsHeader___pwDY9 {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
  margin-bottom: 0.5rem;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.styles-module__settingsBrand___0gJeM {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: -0.0094em;
  color: #fff;
  text-decoration: none;
}

.styles-module__settingsBrandSlash___uTG18 {
  color: var(--agentation-color-accent);
  transition: color 0.2s ease;
}

.styles-module__settingsVersion___TUcFq {
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
  margin-left: auto;
  letter-spacing: -0.0094em;
}

.styles-module__settingsSection___m-YM2 + .styles-module__settingsSection___m-YM2 {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid rgba(255, 255, 255, 0.07);
}
.styles-module__settingsSection___m-YM2.styles-module__settingsSectionExtraPadding___jdhFV {
  padding-top: calc(0.5rem + 4px);
}

.styles-module__settingsSectionGrow___h-5HZ {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.styles-module__settingsRow___3sdhc {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}
.styles-module__settingsRow___3sdhc.styles-module__settingsRowMarginTop___zA0Sp {
  margin-top: 8px;
}

.styles-module__dropdownContainer___BVnxe {
  position: relative;
}

.styles-module__dropdownButton___16NPz {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.5rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  font-size: 0.8125rem;
  font-weight: 600;
  color: #fff;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
  letter-spacing: -0.0094em;
}
.styles-module__dropdownButton___16NPz:hover {
  background: rgba(255, 255, 255, 0.08);
}
.styles-module__dropdownButton___16NPz svg {
  opacity: 0.6;
}

.styles-module__cycleButton___FMKfw {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #fff;
  cursor: pointer;
  letter-spacing: -0.0094em;
}
[data-agentation-theme=light] .styles-module__cycleButton___FMKfw {
  color: rgba(0, 0, 0, 0.85);
}
.styles-module__cycleButton___FMKfw:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.styles-module__settingsRowDisabled___EgS0V .styles-module__settingsLabel___8UjfX {
  color: rgba(255, 255, 255, 0.2);
}
[data-agentation-theme=light] .styles-module__settingsRowDisabled___EgS0V .styles-module__settingsLabel___8UjfX {
  color: rgba(0, 0, 0, 0.2);
}
.styles-module__settingsRowDisabled___EgS0V .styles-module__toggleSwitch___l4Ygm {
  opacity: 0.4;
  cursor: not-allowed;
}

@keyframes styles-module__cycleTextIn___Q6zJf {
  0% {
    opacity: 0;
    transform: translateY(-6px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}
.styles-module__cycleButtonText___fD1LR {
  display: inline-block;
  animation: styles-module__cycleTextIn___Q6zJf 0.2s ease-out;
}

.styles-module__cycleDots___LWuoQ {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.styles-module__cycleDot___nPgLY {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  transform: scale(0.667);
  transition: background-color 0.25s ease-out, transform 0.25s ease-out;
}
.styles-module__cycleDot___nPgLY.styles-module__active___-zoN6 {
  background: #fff;
  transform: scale(1);
}
[data-agentation-theme=light] .styles-module__cycleDot___nPgLY {
  background: rgba(0, 0, 0, 0.2);
}
[data-agentation-theme=light] .styles-module__cycleDot___nPgLY.styles-module__active___-zoN6 {
  background: rgba(0, 0, 0, 0.7);
}

.styles-module__dropdownMenu___k73ER {
  position: absolute;
  right: 0;
  top: calc(100% + 0.25rem);
  background: #1a1a1a;
  border-radius: 0.5rem;
  padding: 0.25rem;
  min-width: 120px;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.1);
  z-index: 10;
  animation: styles-module__scaleIn___c-r1K 0.15s ease-out;
}

.styles-module__dropdownItem___ylsLj {
  width: 100%;
  display: flex;
  align-items: center;
  padding: 0.5rem 0.625rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  font-size: 0.8125rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.85);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.15s ease, color 0.15s ease;
  letter-spacing: -0.0094em;
}
.styles-module__dropdownItem___ylsLj:hover {
  background: rgba(255, 255, 255, 0.08);
}
.styles-module__dropdownItem___ylsLj.styles-module__selected___OwRqP {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
  font-weight: 600;
}

.styles-module__settingsLabel___8UjfX {
  font-size: 0.8125rem;
  font-weight: 400;
  letter-spacing: -0.0094em;
  color: rgba(255, 255, 255, 0.5);
  display: flex;
  align-items: center;
  gap: 0.125rem;
}
[data-agentation-theme=light] .styles-module__settingsLabel___8UjfX {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__settingsLabelMarker___ewdtV {
  padding-top: 3px;
  margin-bottom: 10px;
}

.styles-module__settingsOptions___LyrBA {
  display: flex;
  gap: 0.25rem;
}

.styles-module__settingsOption___UNa12 {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.25rem;
  padding: 0.375rem 0.5rem;
  border: none;
  border-radius: 0.375rem;
  background: transparent;
  font-size: 0.6875rem;
  font-weight: 500;
  color: rgba(0, 0, 0, 0.7);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.styles-module__settingsOption___UNa12:hover {
  background: rgba(0, 0, 0, 0.05);
}
.styles-module__settingsOption___UNa12.styles-module__selected___OwRqP {
  background: color-mix(in srgb, var(--agentation-color-blue) 15%, transparent);
  color: var(--agentation-color-blue);
}

.styles-module__sliderContainer___ducXj {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.styles-module__slider___GLdxp {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 4px;
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
  outline: none;
  cursor: pointer;
}
.styles-module__slider___GLdxp::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  background: white;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.styles-module__slider___GLdxp::-moz-range-thumb {
  width: 14px;
  height: 14px;
  background: white;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
}
.styles-module__slider___GLdxp:hover::-webkit-slider-thumb {
  transform: scale(1.15);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}
.styles-module__slider___GLdxp:hover::-moz-range-thumb {
  transform: scale(1.15);
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.4);
}

.styles-module__sliderLabels___FhLDB {
  display: flex;
  justify-content: space-between;
}

.styles-module__sliderLabel___U8sPr {
  font-size: 0.625rem;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.4);
  cursor: pointer;
  transition: color 0.15s ease;
}
.styles-module__sliderLabel___U8sPr:hover {
  color: rgba(255, 255, 255, 0.7);
}
.styles-module__sliderLabel___U8sPr.styles-module__active___-zoN6 {
  color: rgba(255, 255, 255, 0.9);
}

.styles-module__colorOptions___iHCNX {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.375rem;
  margin-bottom: 1px;
}

.styles-module__colorOption___IodiY {
  display: block;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid transparent;
  background-color: var(--swatch);
  cursor: pointer;
  transition: transform 0.2s cubic-bezier(0.25, 1, 0.5, 1);
}
@supports (color: color(display-p3 0 0 0)) {
  .styles-module__colorOption___IodiY {
    background-color: var(--swatch-p3);
  }
}
.styles-module__colorOption___IodiY:hover {
  transform: scale(1.15);
}
.styles-module__colorOption___IodiY.styles-module__selected___OwRqP {
  transform: scale(0.83);
}

.styles-module__colorOptionRing___U2xpo {
  display: flex;
  width: 24px;
  height: 24px;
  border: 2px solid transparent;
  border-radius: 50%;
  transition: border-color 0.3s ease;
}
.styles-module__colorOptionRing___U2xpo.styles-module__selected___OwRqP {
  border-color: var(--swatch);
}
@supports (color: color(display-p3 0 0 0)) {
  .styles-module__colorOptionRing___U2xpo.styles-module__selected___OwRqP {
    border-color: var(--swatch-p3);
  }
}

.styles-module__settingsToggle___fBrFn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
}
.styles-module__settingsToggle___fBrFn + .styles-module__settingsToggle___fBrFn {
  margin-top: calc(0.5rem + 6px);
}
.styles-module__settingsToggle___fBrFn input[type=checkbox] {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}
.styles-module__settingsToggle___fBrFn.styles-module__settingsToggleMarginBottom___MZUyF {
  margin-bottom: calc(0.5rem + 6px);
}

.styles-module__customCheckbox___U39ax {
  position: relative;
  width: 14px;
  height: 14px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.05);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color 0.25s ease, border-color 0.25s ease;
}
.styles-module__customCheckbox___U39ax svg {
  color: #1a1a1a;
  opacity: 1;
  transition: opacity 0.15s ease;
}
input[type=checkbox]:checked + .styles-module__customCheckbox___U39ax {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgb(255, 255, 255);
}
[data-agentation-theme=light] .styles-module__customCheckbox___U39ax {
  border: 1px solid rgba(0, 0, 0, 0.15);
  background: #fff;
}
[data-agentation-theme=light] .styles-module__customCheckbox___U39ax.styles-module__checked___mnZLo {
  border-color: #1a1a1a;
  background: #1a1a1a;
}
[data-agentation-theme=light] .styles-module__customCheckbox___U39ax.styles-module__checked___mnZLo svg {
  color: #fff;
}

.styles-module__toggleLabel___Xm8Aa {
  font-size: 0.8125rem;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
  letter-spacing: -0.0094em;
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
[data-agentation-theme=light] .styles-module__toggleLabel___Xm8Aa {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__toggleSwitch___l4Ygm {
  position: relative;
  display: inline-block;
  width: 24px;
  height: 16px;
  flex-shrink: 0;
  cursor: pointer;
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.styles-module__toggleSwitch___l4Ygm input {
  opacity: 0;
  width: 0;
  height: 0;
}
.styles-module__toggleSwitch___l4Ygm input:checked + .styles-module__toggleSlider___wprIn {
  background-color: var(--agentation-color-blue);
}
.styles-module__toggleSwitch___l4Ygm input:checked + .styles-module__toggleSlider___wprIn::before {
  transform: translateX(8px);
}
.styles-module__toggleSwitch___l4Ygm.styles-module__disabled___332Jw {
  opacity: 0.4;
}
.styles-module__toggleSwitch___l4Ygm.styles-module__disabled___332Jw .styles-module__toggleSlider___wprIn {
  cursor: not-allowed;
}

.styles-module__toggleSlider___wprIn {
  position: absolute;
  cursor: pointer;
  inset: 0;
  border-radius: 16px;
  background: #484848;
}
[data-agentation-theme=light] .styles-module__toggleSlider___wprIn {
  background: #dddddd;
}
.styles-module__toggleSlider___wprIn::before {
  content: "";
  position: absolute;
  height: 12px;
  width: 12px;
  left: 2px;
  bottom: 2px;
  background: white;
  border-radius: 50%;
  transition: transform 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes styles-module__mcpPulse___uNggr {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 0%, transparent);
  }
}
@keyframes styles-module__mcpPulseError___fov9B {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 50%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-red) 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 0%, transparent);
  }
}
.styles-module__mcpStatusDot___ibgkc {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.styles-module__mcpStatusDot___ibgkc.styles-module__connecting___uo-CW {
  background-color: var(--agentation-color-yellow);
  animation: styles-module__mcpPulse___uNggr 1.5s infinite;
}
.styles-module__mcpStatusDot___ibgkc.styles-module__connected___7c28g {
  background-color: var(--agentation-color-green);
  animation: styles-module__mcpPulse___uNggr 2.5s ease-in-out infinite;
}
.styles-module__mcpStatusDot___ibgkc.styles-module__disconnected___cHPxR {
  background-color: var(--agentation-color-red);
  animation: styles-module__mcpPulseError___fov9B 2s infinite;
}

.styles-module__drawCanvas___7cG9U {
  position: fixed;
  inset: 0;
  z-index: 99996;
  pointer-events: none !important;
}
.styles-module__drawCanvas___7cG9U.styles-module__active___-zoN6 {
  pointer-events: auto !important;
  cursor: crosshair !important;
}
.styles-module__drawCanvas___7cG9U.styles-module__active___-zoN6[data-stroke-hover] {
  cursor: pointer !important;
}

.styles-module__dragSelection___kZLq2 {
  position: fixed;
  top: 0;
  left: 0;
  border: 2px solid color-mix(in srgb, var(--agentation-color-green) 60%, transparent);
  border-radius: 4px;
  background-color: color-mix(in srgb, var(--agentation-color-green) 8%, transparent);
  pointer-events: none;
  z-index: 99997;
  will-change: transform, width, height;
  contain: layout style;
}

.styles-module__dragCount___KM90j {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background-color: var(--agentation-color-green);
  color: white;
  font-size: 0.875rem;
  font-weight: 600;
  padding: 0.25rem 0.5rem;
  border-radius: 1rem;
  min-width: 1.5rem;
  text-align: center;
}

.styles-module__highlightsContainer___-0xzG {
  position: fixed;
  top: 0;
  left: 0;
  pointer-events: none;
  z-index: 99996;
}

.styles-module__selectedElementHighlight___fyVlI {
  position: fixed;
  top: 0;
  left: 0;
  border: 2px solid color-mix(in srgb, var(--agentation-color-green) 50%, transparent);
  border-radius: 4px;
  background: color-mix(in srgb, var(--agentation-color-green) 6%, transparent);
  pointer-events: none;
  will-change: transform, width, height;
  contain: layout style;
}

[data-agentation-theme=light] .styles-module__toolbarContainer___dIhma {
  background: #fff;
  color: rgba(0, 0, 0, 0.85);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);
}
[data-agentation-theme=light] .styles-module__toolbarContainer___dIhma.styles-module__collapsed___Rydsn:hover {
  background: #f5f5f5;
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc {
  color: rgba(0, 0, 0, 0.5);
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc:hover:not(:disabled):not([data-active=true]):not([data-failed=true]):not([data-auto-sync=true]):not([data-error=true]):not([data-no-hover=true]) {
  background: rgba(0, 0, 0, 0.06);
  color: rgba(0, 0, 0, 0.85);
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-active=true] {
  color: var(--agentation-color-blue);
  background: color-mix(in srgb, var(--agentation-color-blue) 15%, transparent);
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-error=true] {
  color: var(--agentation-color-red);
  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-danger]:hover:not(:disabled):not([data-active=true]):not([data-failed=true]) {
  color: var(--agentation-color-red);
  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-auto-sync=true] {
  color: var(--agentation-color-green);
  background: transparent;
}
[data-agentation-theme=light] .styles-module__controlButton___8Q0jc[data-failed=true] {
  color: var(--agentation-color-red);
  background: color-mix(in srgb, var(--agentation-color-red) 15%, transparent);
}
[data-agentation-theme=light] .styles-module__buttonTooltip___Burd9 {
  background: #fff;
  color: rgba(0, 0, 0, 0.85);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);
}
[data-agentation-theme=light] .styles-module__buttonTooltip___Burd9::after {
  background: #fff;
}
[data-agentation-theme=light] .styles-module__divider___c--s1 {
  background: rgba(0, 0, 0, 0.1);
}`,Q2={toolbar:"styles-module__toolbar___wNsdK",markersLayer:"styles-module__markersLayer___-25j1",fixedMarkersLayer:"styles-module__fixedMarkersLayer___ffyX6",controlsContent:"styles-module__controlsContent___9GJWU",disableTransitions:"styles-module__disableTransitions___EopxO",toolbarContainer:"styles-module__toolbarContainer___dIhma",entrance:"styles-module__entrance___sgHd8",toolbarEnter:"styles-module__toolbarEnter___u8RRu",hiding:"styles-module__hiding___1td44",toolbarHide:"styles-module__toolbarHide___y8kaT",collapsed:"styles-module__collapsed___Rydsn",expanded:"styles-module__expanded___ofKPx",serverConnected:"styles-module__serverConnected___Gfbou",toggleContent:"styles-module__toggleContent___0yfyP",visible:"styles-module__visible___KHwEW",hidden:"styles-module__hidden___Ae8H4",badge:"styles-module__badge___2XsgF",fadeOut:"styles-module__fadeOut___6Ut6-",badgeEnter:"styles-module__badgeEnter___mVQLj",controlButton:"styles-module__controlButton___8Q0jc",statusShowing:"styles-module__statusShowing___te6iu",buttonBadge:"styles-module__buttonBadge___NeFWb",mcpIndicator:"styles-module__mcpIndicator___zGJeL",connected:"styles-module__connected___7c28g",mcpIndicatorPulseConnected:"styles-module__mcpIndicatorPulseConnected___EDodZ",connecting:"styles-module__connecting___uo-CW",mcpIndicatorPulseConnecting:"styles-module__mcpIndicatorPulseConnecting___cCYte",connectionIndicatorWrapper:"styles-module__connectionIndicatorWrapper___L-e-3",connectionIndicator:"styles-module__connectionIndicator___afk9p",connectionIndicatorVisible:"styles-module__connectionIndicatorVisible___C-i5B",connectionIndicatorConnected:"styles-module__connectionIndicatorConnected___IY8pR",connectionPulse:"styles-module__connectionPulse___-Zycw",connectionIndicatorDisconnected:"styles-module__connectionIndicatorDisconnected___kmpaZ",connectionIndicatorConnecting:"styles-module__connectionIndicatorConnecting___QmSLH",buttonWrapper:"styles-module__buttonWrapper___rBcdv",buttonTooltip:"styles-module__buttonTooltip___Burd9",tooltipsInSession:"styles-module__tooltipsInSession___-0lHH",sendButtonWrapper:"styles-module__sendButtonWrapper___UUxG6",sendButtonVisible:"styles-module__sendButtonVisible___WPSQU",shortcut:"styles-module__shortcut___lEAQk",tooltipBelow:"styles-module__tooltipBelow___m6ats",tooltipsHidden:"styles-module__tooltipsHidden___VtLJG",tooltipVisible:"styles-module__tooltipVisible___0jcCv",buttonWrapperAlignLeft:"styles-module__buttonWrapperAlignLeft___myzIp",buttonWrapperAlignRight:"styles-module__buttonWrapperAlignRight___HCQFR",divider:"styles-module__divider___c--s1",overlay:"styles-module__overlay___Q1O9y",hoverHighlight:"styles-module__hoverHighlight___ogakW",enter:"styles-module__enter___WFIki",hoverHighlightIn:"styles-module__hoverHighlightIn___6WYHY",multiSelectOutline:"styles-module__multiSelectOutline___cSJ-m",fadeIn:"styles-module__fadeIn___b9qmf",exit:"styles-module__exit___fyOJ0",singleSelectOutline:"styles-module__singleSelectOutline___QhX-O",hoverTooltip:"styles-module__hoverTooltip___bvLk7",hoverTooltipIn:"styles-module__hoverTooltipIn___FYGQx",hoverReactPath:"styles-module__hoverReactPath___gx1IJ",hoverElementName:"styles-module__hoverElementName___QMLMl",marker:"styles-module__marker___6sQrs",clearing:"styles-module__clearing___FQ--7",markerIn:"styles-module__markerIn___5FaAP",markerOut:"styles-module__markerOut___GU5jX",pending:"styles-module__pending___2IHLC",fixed:"styles-module__fixed___dBMHC",multiSelect:"styles-module__multiSelect___YWiuz",hovered:"styles-module__hovered___ZgXIy",renumber:"styles-module__renumber___nCTxD",renumberRoll:"styles-module__renumberRoll___Wgbq3",markerTooltip:"styles-module__markerTooltip___aLJID",tooltipIn:"styles-module__tooltipIn___0N31w",markerQuote:"styles-module__markerQuote___FHmrz",markerNote:"styles-module__markerNote___QkrrS",markerHint:"styles-module__markerHint___2iF-6",settingsPanel:"styles-module__settingsPanel___OxX3Y",settingsHeader:"styles-module__settingsHeader___pwDY9",settingsBrand:"styles-module__settingsBrand___0gJeM",settingsBrandSlash:"styles-module__settingsBrandSlash___uTG18",settingsVersion:"styles-module__settingsVersion___TUcFq",settingsSection:"styles-module__settingsSection___m-YM2",settingsLabel:"styles-module__settingsLabel___8UjfX",cycleButton:"styles-module__cycleButton___FMKfw",cycleDot:"styles-module__cycleDot___nPgLY",dropdownButton:"styles-module__dropdownButton___16NPz",toggleLabel:"styles-module__toggleLabel___Xm8Aa",customCheckbox:"styles-module__customCheckbox___U39ax",sliderLabel:"styles-module__sliderLabel___U8sPr",slider:"styles-module__slider___GLdxp",themeToggle:"styles-module__themeToggle___2rUjA",settingsOption:"styles-module__settingsOption___UNa12",selected:"styles-module__selected___OwRqP",settingsPanelContainer:"styles-module__settingsPanelContainer___Xksv8",settingsPage:"styles-module__settingsPage___6YfHH",slideLeft:"styles-module__slideLeft___Ps01J",automationsPage:"styles-module__automationsPage___uvCq6",slideIn:"styles-module__slideIn___4-qXe",settingsNavLink:"styles-module__settingsNavLink___wCzJt",settingsNavLinkRight:"styles-module__settingsNavLinkRight___ZWwhj",mcpNavIndicator:"styles-module__mcpNavIndicator___cl9pO",mcpPulse:"styles-module__mcpPulse___uNggr",settingsBackButton:"styles-module__settingsBackButton___bIe2j",automationHeader:"styles-module__automationHeader___InP0r",automationDescription:"styles-module__automationDescription___NKlmo",learnMoreLink:"styles-module__learnMoreLink___8xv-x",autoSendRow:"styles-module__autoSendRow___UblX5",autoSendLabel:"styles-module__autoSendLabel___icDc2",active:"styles-module__active___-zoN6",webhookUrlInput:"styles-module__webhookUrlInput___2375C",settingsSectionExtraPadding:"styles-module__settingsSectionExtraPadding___jdhFV",settingsSectionGrow:"styles-module__settingsSectionGrow___h-5HZ",settingsRow:"styles-module__settingsRow___3sdhc",settingsRowMarginTop:"styles-module__settingsRowMarginTop___zA0Sp",dropdownContainer:"styles-module__dropdownContainer___BVnxe",settingsRowDisabled:"styles-module__settingsRowDisabled___EgS0V",toggleSwitch:"styles-module__toggleSwitch___l4Ygm",cycleButtonText:"styles-module__cycleButtonText___fD1LR",cycleTextIn:"styles-module__cycleTextIn___Q6zJf",cycleDots:"styles-module__cycleDots___LWuoQ",dropdownMenu:"styles-module__dropdownMenu___k73ER",scaleIn:"styles-module__scaleIn___c-r1K",dropdownItem:"styles-module__dropdownItem___ylsLj",settingsLabelMarker:"styles-module__settingsLabelMarker___ewdtV",settingsOptions:"styles-module__settingsOptions___LyrBA",sliderContainer:"styles-module__sliderContainer___ducXj",sliderLabels:"styles-module__sliderLabels___FhLDB",colorOptions:"styles-module__colorOptions___iHCNX",colorOption:"styles-module__colorOption___IodiY",colorOptionRing:"styles-module__colorOptionRing___U2xpo",settingsToggle:"styles-module__settingsToggle___fBrFn",settingsToggleMarginBottom:"styles-module__settingsToggleMarginBottom___MZUyF",checked:"styles-module__checked___mnZLo",toggleSlider:"styles-module__toggleSlider___wprIn",disabled:"styles-module__disabled___332Jw",mcpStatusDot:"styles-module__mcpStatusDot___ibgkc",disconnected:"styles-module__disconnected___cHPxR",mcpPulseError:"styles-module__mcpPulseError___fov9B",drawCanvas:"styles-module__drawCanvas___7cG9U",dragSelection:"styles-module__dragSelection___kZLq2",dragCount:"styles-module__dragCount___KM90j",highlightsContainer:"styles-module__highlightsContainer___-0xzG",selectedElementHighlight:"styles-module__selectedElementHighlight___fyVlI",scaleOut:"styles-module__scaleOut___Wctwz",slideUp:"styles-module__slideUp___kgD36",slideDown:"styles-module__slideDown___zcdje"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-page-toolbar-css-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-page-toolbar-css-styles",document.head.appendChild(e)),e.textContent=X2}var A=Q2,Ti=[{value:"compact",label:"Compact"},{value:"standard",label:"Standard"},{value:"detailed",label:"Detailed"},{value:"forensic",label:"Forensic"}];function _p(e,t,n="standard"){if(e.length===0)return"";let o=typeof window<"u"?`${window.innerWidth}\xD7${window.innerHeight}`:"unknown",r=`## Page Feedback: ${t}
`;return n==="forensic"?(r+=`
**Environment:**
`,r+=`- Viewport: ${o}
`,typeof window<"u"&&(r+=`- URL: ${window.location.href}
`,r+=`- User Agent: ${navigator.userAgent}
`,r+=`- Timestamp: ${new Date().toISOString()}
`,r+=`- Device Pixel Ratio: ${window.devicePixelRatio}
`),r+=`
---
`):n!=="compact"&&(r+=`**Viewport:** ${o}
`),r+=`
`,e.forEach((l,i)=>{n==="compact"?(r+=`${i+1}. **${l.element}**${l.sourceFile?` (${l.sourceFile})`:""}: ${l.comment}`,l.selectedText&&(r+=` (re: "${l.selectedText.slice(0,30)}${l.selectedText.length>30?"...":""}")`),r+=`
`):n==="forensic"?(r+=`### ${i+1}. ${l.element}
`,l.isMultiSelect&&l.fullPath&&(r+=`*Forensic data shown for first element of selection*
`),l.fullPath&&(r+=`**Full DOM Path:** ${l.fullPath}
`),l.cssClasses&&(r+=`**CSS Classes:** ${l.cssClasses}
`),l.boundingBox&&(r+=`**Position:** x:${Math.round(l.boundingBox.x)}, y:${Math.round(l.boundingBox.y)} (${Math.round(l.boundingBox.width)}\xD7${Math.round(l.boundingBox.height)}px)
`),r+=`**Annotation at:** ${l.x.toFixed(1)}% from left, ${Math.round(l.y)}px from top
`,l.selectedText&&(r+=`**Selected text:** "${l.selectedText}"
`),l.nearbyText&&!l.selectedText&&(r+=`**Context:** ${l.nearbyText.slice(0,100)}
`),l.computedStyles&&(r+=`**Computed Styles:** ${l.computedStyles}
`),l.accessibility&&(r+=`**Accessibility:** ${l.accessibility}
`),l.nearbyElements&&(r+=`**Nearby Elements:** ${l.nearbyElements}
`),l.sourceFile&&(r+=`**Source:** ${l.sourceFile}
`),l.reactComponents&&(r+=`**React:** ${l.reactComponents}
`),r+=`**Feedback:** ${l.comment}

`):(r+=`### ${i+1}. ${l.element}
`,r+=`**Location:** ${l.elementPath}
`,l.sourceFile&&(r+=`**Source:** ${l.sourceFile}
`),l.reactComponents&&(r+=`**React:** ${l.reactComponents}
`),n==="detailed"&&(l.cssClasses&&(r+=`**Classes:** ${l.cssClasses}
`),l.boundingBox&&(r+=`**Position:** ${Math.round(l.boundingBox.x)}px, ${Math.round(l.boundingBox.y)}px (${Math.round(l.boundingBox.width)}\xD7${Math.round(l.boundingBox.height)}px)
`)),l.selectedText&&(r+=`**Selected text:** "${l.selectedText}"
`),n==="detailed"&&l.nearbyText&&!l.selectedText&&(r+=`**Context:** ${l.nearbyText.slice(0,100)}
`),r+=`**Feedback:** ${l.comment}

`)}),r.trim()}var V2=`@keyframes styles-module__markerIn___x4G8D {
  0% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.3);
  }
  100% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
}
@keyframes styles-module__markerOut___6VhQN {
  0% {
    opacity: 1;
    transform: translate(-50%, -50%) scale(1);
  }
  100% {
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.3);
  }
}
@keyframes styles-module__tooltipIn___aJslQ {
  from {
    opacity: 0;
    transform: translateX(-50%) translateY(2px) scale(0.891);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0) scale(0.909);
  }
}
@keyframes styles-module__renumberRoll___akV9B {
  0% {
    transform: translateX(-40%);
    opacity: 0;
  }
  100% {
    transform: translateX(0);
    opacity: 1;
  }
}
.styles-module__marker___9CKF7 {
  position: absolute;
  width: 22px;
  height: 22px;
  background: var(--agentation-color-blue);
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6875rem;
  font-weight: 600;
  transform: translate(-50%, -50%) scale(1);
  opacity: 1;
  cursor: pointer;
  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2), inset 0 0 0 1px rgba(0, 0, 0, 0.04);
  user-select: none;
  will-change: transform, opacity;
  contain: layout style;
  z-index: 1;
}
.styles-module__marker___9CKF7:hover {
  z-index: 2;
}
.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K) {
  transition: background-color 0.15s ease, transform 0.1s ease;
}
.styles-module__marker___9CKF7.styles-module__enter___8kI3q {
  animation: styles-module__markerIn___x4G8D 0.25s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.styles-module__marker___9CKF7.styles-module__exit___KBdR3 {
  animation: styles-module__markerOut___6VhQN 0.2s ease-out both;
  pointer-events: none;
}
.styles-module__marker___9CKF7.styles-module__clearing___8rM7K {
  animation: styles-module__markerOut___6VhQN 0.15s ease-out both;
  pointer-events: none;
}
.styles-module__marker___9CKF7:not(.styles-module__enter___8kI3q):not(.styles-module__exit___KBdR3):not(.styles-module__clearing___8rM7K):hover {
  transform: translate(-50%, -50%) scale(1.1);
}
.styles-module__marker___9CKF7.styles-module__pending___BiY-U {
  position: fixed;
  background-color: var(--agentation-color-blue);
  cursor: default;
}
.styles-module__marker___9CKF7.styles-module__fixed___aKrQO {
  position: fixed;
}
.styles-module__marker___9CKF7.styles-module__multiSelect___CPfTC {
  background-color: var(--agentation-color-green);
  width: 26px;
  height: 26px;
  border-radius: 6px;
  font-size: 0.75rem;
}
.styles-module__marker___9CKF7.styles-module__multiSelect___CPfTC.styles-module__pending___BiY-U {
  background-color: var(--agentation-color-green);
}
.styles-module__marker___9CKF7.styles-module__hovered___-mg2N {
  background-color: var(--agentation-color-red);
}

.styles-module__renumber___16lvD {
  display: block;
  animation: styles-module__renumberRoll___akV9B 0.2s ease-out;
}

.styles-module__markerTooltip___-VUm- {
  position: absolute;
  top: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%) scale(0.909);
  z-index: 100002;
  background: #1a1a1a;
  padding: 8px 0.75rem;
  border-radius: 0.75rem;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-weight: 400;
  color: #fff;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);
  min-width: 120px;
  max-width: 200px;
  pointer-events: none;
  cursor: default;
}
.styles-module__markerTooltip___-VUm-.styles-module__enter___8kI3q {
  animation: styles-module__tooltipIn___aJslQ 0.1s ease-out forwards;
}

.styles-module__markerQuote___tQake {
  display: block;
  font-size: 12px;
  font-style: italic;
  color: rgba(255, 255, 255, 0.6);
  margin-bottom: 0.3125rem;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.styles-module__markerNote___Rh4eI {
  display: block;
  font-size: 13px;
  font-weight: 400;
  line-height: 1.4;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-bottom: 2px;
}

[data-agentation-theme=light] .styles-module__markerTooltip___-VUm- {
  background: #fff;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.12), 0 0 0 1px rgba(0, 0, 0, 0.06);
}
[data-agentation-theme=light] .styles-module__markerTooltip___-VUm- .styles-module__markerQuote___tQake {
  color: rgba(0, 0, 0, 0.5);
}
[data-agentation-theme=light] .styles-module__markerTooltip___-VUm- .styles-module__markerNote___Rh4eI {
  color: rgba(0, 0, 0, 0.85);
}`,K2={marker:"styles-module__marker___9CKF7",enter:"styles-module__enter___8kI3q",exit:"styles-module__exit___KBdR3",clearing:"styles-module__clearing___8rM7K",markerIn:"styles-module__markerIn___x4G8D",markerOut:"styles-module__markerOut___6VhQN",pending:"styles-module__pending___BiY-U",fixed:"styles-module__fixed___aKrQO",multiSelect:"styles-module__multiSelect___CPfTC",hovered:"styles-module__hovered___-mg2N",renumber:"styles-module__renumber___16lvD",renumberRoll:"styles-module__renumberRoll___akV9B",markerTooltip:"styles-module__markerTooltip___-VUm-",tooltipIn:"styles-module__tooltipIn___aJslQ",markerQuote:"styles-module__markerQuote___tQake",markerNote:"styles-module__markerNote___Rh4eI"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-annotation-marker-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-annotation-marker-styles",document.head.appendChild(e)),e.textContent=V2}var Tt=K2;function fp({annotation:e,globalIndex:t,layerIndex:n,layerSize:o,isExiting:r,isClearing:l,isAnimated:i,isHovered:s,isDeleting:a,isEditingAny:m,renumberFrom:p,markerClickBehavior:b,tooltipStyle:y,onHoverEnter:$,onHoverLeave:C,onClick:I,onContextMenu:E}){let f=(s||a)&&!m,g=f&&b==="delete",w=e.isMultiSelect,N=w?"var(--agentation-color-green)":"var(--agentation-color-accent)",H=r?Tt.exit:l?Tt.clearing:i?"":Tt.enter,V=r?`${(o-1-n)*20}ms`:`${n*20}ms`;return(0,Cn.jsxs)("div",{className:`${Tt.marker} ${w?Tt.multiSelect:""} ${H} ${g?Tt.hovered:""}`,"data-annotation-marker":!0,style:{left:`${e.x}%`,top:e.y,backgroundColor:g?void 0:N,animationDelay:V},onMouseEnter:()=>$(e),onMouseLeave:C,onClick:D=>{D.stopPropagation(),r||I(e)},onContextMenu:E?D=>{b==="delete"&&(D.preventDefault(),D.stopPropagation(),r||E(e))}:void 0,children:[f?g?(0,Cn.jsx)(xp,{size:w?18:16}):(0,Cn.jsx)(ay,{size:16}):(0,Cn.jsx)("span",{className:p!==null&&t>=p?Tt.renumber:void 0,children:t+1}),s&&!m&&(0,Cn.jsxs)("div",{className:`${Tt.markerTooltip} ${Tt.enter}`,style:y,children:[(0,Cn.jsxs)("span",{className:Tt.markerQuote,children:[e.element,e.selectedText&&` "${e.selectedText.slice(0,30)}${e.selectedText.length>30?"...":""}"`]}),(0,Cn.jsx)("span",{className:Tt.markerNote,children:e.comment})]})]})}function G2({x:e,y:t,isMultiSelect:n,isExiting:o}){return(0,Cn.jsx)("div",{className:`${Tt.marker} ${Tt.pending} ${n?Tt.multiSelect:""} ${o?Tt.exit:Tt.enter}`,style:{left:`${e}%`,top:t,backgroundColor:n?"var(--agentation-color-green)":"var(--agentation-color-accent)"},children:(0,Cn.jsx)(Gg,{size:12})})}function hp({annotation:e,fixed:t}){let n=e.isMultiSelect;return(0,Cn.jsx)("div",{className:`${Tt.marker} ${t?Tt.fixed:""} ${Tt.hovered} ${n?Tt.multiSelect:""} ${Tt.exit}`,"data-annotation-marker":!0,style:{left:`${e.x}%`,top:e.y},children:(0,Cn.jsx)(xp,{size:n?12:10})})}var q2=`.styles-module__switchContainer___Ka-AB {
  display: flex;
  align-items: center;
  position: relative;
  padding: 2px;
  width: 24px;
  height: 16px;
  border-radius: 8px;
  background-color: #cdcdcd;
  transition: background-color 0.15s, opacity 0.15s;
}
[data-agentation-theme=dark] .styles-module__switchContainer___Ka-AB {
  background-color: #484848;
}
.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:checked) {
  background-color: var(--agentation-color-blue);
}
.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:disabled) {
  opacity: 0.3;
}

.styles-module__switchInput___kYDSD {
  position: absolute;
  z-index: 1;
  inset: 0;
  border-radius: inherit;
  opacity: 0;
  cursor: pointer;
}
.styles-module__switchInput___kYDSD:disabled {
  cursor: not-allowed;
}

.styles-module__switchThumb___4sCPH {
  border-radius: 50%;
  width: 12px;
  height: 12px;
  background-color: #fff;
  transition: transform 0.15s;
}
.styles-module__switchContainer___Ka-AB:has(.styles-module__switchInput___kYDSD:checked) .styles-module__switchThumb___4sCPH {
  transform: translateX(8px);
}`,Z2={switchContainer:"styles-module__switchContainer___Ka-AB",switchInput:"styles-module__switchInput___kYDSD",switchThumb:"styles-module__switchThumb___4sCPH"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-switch-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-switch-styles",document.head.appendChild(e)),e.textContent=q2}var wu=Z2,bu=({className:e="",...t})=>(0,Bi.jsxs)("div",{className:`${wu.switchContainer} ${e}`,children:[(0,Bi.jsx)("input",{className:wu.switchInput,type:"checkbox",...t}),(0,Bi.jsx)("div",{className:wu.switchThumb})]}),J2=`.styles-module__checkboxContainer___joqZk {
  display: flex;
  justify-content: center;
  align-items: center;
  position: relative;
  border: 1px solid rgba(26, 26, 26, 0.2);
  border-radius: 4px;
  width: 14px;
  height: 14px;
  background-color: #fff;
  transition: background-color 0.2s ease;
}
[data-agentation-theme=dark] .styles-module__checkboxContainer___joqZk {
  border-color: rgba(255, 255, 255, 0.2);
  background-color: #252525;
}
.styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) {
  background-color: #1a1a1a;
}
[data-agentation-theme=dark] .styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) {
  background-color: #fff;
}

.styles-module__checkboxInput___ECzzO {
  position: absolute;
  z-index: 1;
  inset: -1px;
  border-radius: inherit;
  opacity: 0;
  cursor: pointer;
}

.styles-module__checkboxCheck___fUXpr {
  color: #fafafa;
}
[data-agentation-theme=dark] .styles-module__checkboxCheck___fUXpr {
  color: #1a1a1a;
}

.styles-module__checkboxCheckPath___cDyh8 {
  stroke-dasharray: 9.29px;
  stroke-dashoffset: 9.29px;
  color: #fafafa;
  transition: stroke-dashoffset 0.1s ease;
}
[data-agentation-theme=dark] .styles-module__checkboxCheckPath___cDyh8 {
  color: #1a1a1a;
}
.styles-module__checkboxContainer___joqZk:has(.styles-module__checkboxInput___ECzzO:checked) .styles-module__checkboxCheckPath___cDyh8 {
  transition-duration: 0.2s;
  stroke-dashoffset: 0;
}`,ex={checkboxContainer:"styles-module__checkboxContainer___joqZk",checkboxInput:"styles-module__checkboxInput___ECzzO",checkboxCheck:"styles-module__checkboxCheck___fUXpr",checkboxCheckPath:"styles-module__checkboxCheckPath___cDyh8"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-checkbox-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-checkbox-styles",document.head.appendChild(e)),e.textContent=J2}var Ia=ex,tx=({className:e="",...t})=>(0,bl.jsxs)("div",{className:`${Ia.checkboxContainer} ${e}`,children:[(0,bl.jsx)("input",{className:Ia.checkboxInput,type:"checkbox",...t}),(0,bl.jsx)("svg",{className:Ia.checkboxCheck,width:"14",height:"14",viewBox:"0 0 14 14",fill:"none",children:(0,bl.jsx)("path",{className:Ia.checkboxCheckPath,d:"M3.94 7L6.13 9.19L10.5 4.81",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})})]}),nx=`.styles-module__container___w8eAF {
  display: flex;
  align-items: center;
  height: 24px;
}

.styles-module__label___J5mxE {
  padding-inline: 8px 2px;
  line-height: 20px;
  font-size: 13px;
  letter-spacing: -0.15px;
  color: rgba(26, 26, 26, 0.5);
  cursor: pointer;
}
[data-agentation-theme=dark] .styles-module__label___J5mxE {
  color: rgba(255, 255, 255, 0.5);
}`,ox={container:"styles-module__container___w8eAF",label:"styles-module__label___J5mxE"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-checkbox-field-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-checkbox-field-styles",document.head.appendChild(e)),e.textContent=nx}var pp=ox,mp=({className:e="",label:t,tooltip:n,checked:o,onChange:r,...l})=>{let i=(0,Bp.useId)();return(0,kl.jsxs)("div",{className:`${pp.container} ${e}`,...l,children:[(0,kl.jsx)(tx,{id:i,onChange:r,checked:o}),(0,kl.jsx)("label",{className:pp.label,htmlFor:i,children:t}),n&&(0,kl.jsx)(Nr,{content:n})]})},rx=`@keyframes styles-module__cycleTextIn___VBNTi {
  0% {
    opacity: 0;
    transform: translateY(-6px);
  }
  100% {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes styles-module__scaleIn___QpQ8E {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}
@keyframes styles-module__mcpPulse___5Q3Jj {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 50%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-green) 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-green) 0%, transparent);
  }
}
@keyframes styles-module__mcpPulseError___VHxhx {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 50%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px color-mix(in srgb, var(--agentation-color-red) 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--agentation-color-red) 0%, transparent);
  }
}
@keyframes styles-module__themeIconIn___qUWMV {
  0% {
    opacity: 0;
    transform: scale(0.8) rotate(-30deg);
  }
  100% {
    opacity: 1;
    transform: scale(1) rotate(0deg);
  }
}
.styles-module__settingsPanel___qNkn- {
  position: absolute;
  right: 5px;
  bottom: calc(100% + 0.5rem);
  z-index: 1;
  overflow: hidden;
  background: #1c1c1c;
  border-radius: 16px;
  padding: 12px 0;
  width: 100%;
  max-width: 253px;
  min-width: 205px;
  cursor: default;
  opacity: 1;
  box-shadow: 0 1px 8px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0, 0, 0, 0.04);
  transition: background-color 0.25s ease, box-shadow 0.25s ease;
}
.styles-module__settingsPanel___qNkn-::before, .styles-module__settingsPanel___qNkn-::after {
  content: "";
  position: absolute;
  top: 0;
  bottom: 0;
  width: 16px;
  z-index: 2;
  pointer-events: none;
}
.styles-module__settingsPanel___qNkn-::before {
  left: 0;
  background: linear-gradient(to right, #1c1c1c 0%, transparent 100%);
}
.styles-module__settingsPanel___qNkn-::after {
  right: 0;
  background: linear-gradient(to left, #1c1c1c 0%, transparent 100%);
}
.styles-module__settingsPanel___qNkn- .styles-module__settingsHeader___Fn1DP,
.styles-module__settingsPanel___qNkn- .styles-module__settingsBrand___OoKlM,
.styles-module__settingsPanel___qNkn- .styles-module__settingsBrandSlash___Q-AU9,
.styles-module__settingsPanel___qNkn- .styles-module__settingsVersion___rXmL9,
.styles-module__settingsPanel___qNkn- .styles-module__settingsSection___n5V-4,
.styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ,
.styles-module__settingsPanel___qNkn- .styles-module__cycleButton___XMBx3,
.styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY,
.styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8,
.styles-module__settingsPanel___qNkn- .styles-module__sliderLabel___6K5v1,
.styles-module__settingsPanel___qNkn- .styles-module__slider___v5z-c,
.styles-module__settingsPanel___qNkn- .styles-module__themeToggle___3imlT {
  transition: background-color 0.25s ease, color 0.25s ease, border-color 0.25s ease;
}
.styles-module__settingsPanel___qNkn-.styles-module__enter___wginS {
  opacity: 1;
  transform: translateY(0) scale(1);
  filter: blur(0px);
  transition: opacity 0.2s ease, transform 0.2s ease, filter 0.2s ease;
}
.styles-module__settingsPanel___qNkn-.styles-module__exit___A4iJc {
  opacity: 0;
  transform: translateY(8px) scale(0.95);
  filter: blur(5px);
  pointer-events: none;
  transition: opacity 0.1s ease, transform 0.1s ease, filter 0.1s ease;
}
[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- {
  background: #1a1a1a;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3), 0 0 0 1px rgba(255, 255, 255, 0.08);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ {
  color: rgba(255, 255, 255, 0.6);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH- {
  color: rgba(255, 255, 255, 0.85);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH-:hover {
  background: rgba(255, 255, 255, 0.1);
}
[data-agentation-theme=dark] .styles-module__settingsPanel___qNkn- .styles-module__settingsOption___JoyH-.styles-module__selected___k1-Vq {
  background: rgba(255, 255, 255, 0.15);
  color: #fff;
}

.styles-module__settingsPanelContainer___5it-H {
  overflow: visible;
  position: relative;
  display: flex;
  padding: 0 16px;
}

.styles-module__settingsPage___BMn-3 {
  min-width: 100%;
  flex-basis: 0;
  flex-shrink: 0;
  transition: transform 0.2s ease, opacity 0.2s ease;
  transition-delay: 0s;
  opacity: 1;
}

.styles-module__settingsPage___BMn-3.styles-module__slideLeft___qUvW4 {
  transform: translateX(-24px);
  opacity: 0;
  pointer-events: none;
}

.styles-module__automationsPage___N7By0 {
  position: absolute;
  top: 0;
  left: 24px;
  width: 100%;
  height: 100%;
  padding: 0 16px 4px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  transition: transform 0.2s ease, opacity 0.2s ease;
  opacity: 0;
  pointer-events: none;
}

.styles-module__automationsPage___N7By0.styles-module__slideIn___uXDSu {
  transform: translateX(-24px);
  opacity: 1;
  pointer-events: auto;
}

.styles-module__settingsHeader___Fn1DP {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 24px;
}

.styles-module__settingsBrand___OoKlM {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: -0.0094em;
  color: #fff;
  text-decoration: none;
}

.styles-module__settingsBrandSlash___Q-AU9 {
  color: var(--agentation-color-accent);
  transition: color 0.2s ease;
}

.styles-module__settingsVersion___rXmL9 {
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
  margin-left: auto;
  letter-spacing: -0.0094em;
}

.styles-module__themeToggle___3imlT {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  margin-left: 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: rgba(255, 255, 255, 0.4);
  transition: background-color 0.15s ease, color 0.15s ease;
  cursor: pointer;
}
.styles-module__themeToggle___3imlT:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.8);
}
[data-agentation-theme=light] .styles-module__themeToggle___3imlT {
  color: rgba(0, 0, 0, 0.4);
}
[data-agentation-theme=light] .styles-module__themeToggle___3imlT:hover {
  background: rgba(0, 0, 0, 0.06);
  color: rgba(0, 0, 0, 0.7);
}

.styles-module__themeIconWrapper___pyaYa {
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  width: 20px;
  height: 20px;
}

.styles-module__themeIcon___w7lAm {
  display: flex;
  align-items: center;
  justify-content: center;
  animation: styles-module__themeIconIn___qUWMV 0.35s cubic-bezier(0.34, 1.56, 0.64, 1) forwards;
}

.styles-module__settingsSectionGrow___eZTRw {
  flex: 1;
  display: flex;
  flex-direction: column;
}

.styles-module__settingsRow___y-tDE {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 24px;
}
.styles-module__settingsRow___y-tDE.styles-module__settingsRowMarginTop___uLpGb {
  margin-top: 8px;
}

.styles-module__settingsRowDisabled___ydl3Q .styles-module__settingsLabel___VCVOQ {
  color: rgba(255, 255, 255, 0.2);
}
[data-agentation-theme=light] .styles-module__settingsRowDisabled___ydl3Q .styles-module__settingsLabel___VCVOQ {
  color: rgba(0, 0, 0, 0.2);
}

.styles-module__settingsLabel___VCVOQ {
  display: flex;
  align-items: center;
  column-gap: 2px;
  line-height: 20px;
  font-size: 13px;
  font-weight: 400;
  letter-spacing: -0.15px;
  color: rgba(255, 255, 255, 0.5);
}
[data-agentation-theme=light] .styles-module__settingsLabel___VCVOQ {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__cycleButton___XMBx3 {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 0.8125rem;
  font-weight: 500;
  color: #fff;
  cursor: pointer;
  letter-spacing: -0.0094em;
}
[data-agentation-theme=light] .styles-module__cycleButton___XMBx3 {
  color: rgba(0, 0, 0, 0.85);
}
.styles-module__cycleButton___XMBx3:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.styles-module__cycleButtonText___mbbnD {
  display: inline-block;
  animation: styles-module__cycleTextIn___VBNTi 0.2s ease-out;
}

.styles-module__cycleDots___ehp6i {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.styles-module__cycleDot___zgSXY {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.3);
  transform: scale(0.667);
  transition: background-color 0.25s ease-out, transform 0.25s ease-out;
}
.styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {
  background: #fff;
  transform: scale(1);
}
[data-agentation-theme=light] .styles-module__cycleDot___zgSXY {
  background: rgba(0, 0, 0, 0.2);
}
[data-agentation-theme=light] .styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {
  background: rgba(0, 0, 0, 0.7);
}

.styles-module__colorOptions___pbxZx {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 6px;
  height: 26px;
}

.styles-module__colorOption___Co955 {
  padding: 0;
  position: relative;
  border-radius: 50%;
  width: 20px;
  height: 20px;
  background-color: #fff;
  cursor: pointer;
}
[data-agentation-theme=dark] .styles-module__colorOption___Co955 {
  background-color: #1a1a1a;
}
.styles-module__colorOption___Co955::before, .styles-module__colorOption___Co955::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background-color: var(--swatch);
  transition: opacity 0.2s, transform 0.2s;
}
@supports (color: color(display-p3 0 0 0)) {
  .styles-module__colorOption___Co955::before, .styles-module__colorOption___Co955::after {
    --color: var(--swatch-p3);
  }
}
.styles-module__colorOption___Co955::after {
  z-index: -1;
  transform: scale(1.2);
  opacity: 0;
}
.styles-module__colorOption___Co955.styles-module__selected___k1-Vq::before {
  transform: scale(0.8);
}
.styles-module__colorOption___Co955.styles-module__selected___k1-Vq::after {
  opacity: 1;
}

.styles-module__settingsNavLink___uYIwM {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  font-family: inherit;
  line-height: 20px;
  font-size: 13px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.5);
  transition: color 0.15s ease;
  cursor: pointer;
}
.styles-module__settingsNavLink___uYIwM:hover {
  color: rgba(255, 255, 255, 0.9);
}
.styles-module__settingsNavLink___uYIwM svg {
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.15s ease;
}
.styles-module__settingsNavLink___uYIwM:hover svg {
  color: #fff;
}
[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM {
  color: rgba(0, 0, 0, 0.5);
}
[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM:hover {
  color: rgba(0, 0, 0, 0.8);
}
[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM svg {
  color: rgba(0, 0, 0, 0.25);
}
[data-agentation-theme=light] .styles-module__settingsNavLink___uYIwM:hover svg {
  color: rgba(0, 0, 0, 0.8);
}

.styles-module__settingsNavLinkRight___XBUzC {
  display: flex;
  align-items: center;
  gap: 6px;
}

.styles-module__settingsBackButton___fflll {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  background: transparent;
  font-family: inherit;
  line-height: 20px;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.15px;
  color: #fff;
  cursor: pointer;
  transition: transform 0.12s cubic-bezier(0.32, 0.72, 0, 1);
}
.styles-module__settingsBackButton___fflll svg {
  opacity: 0.4;
  flex-shrink: 0;
  transition: opacity 0.15s ease, transform 0.18s cubic-bezier(0.32, 0.72, 0, 1);
}
.styles-module__settingsBackButton___fflll:hover svg {
  opacity: 1;
}
[data-agentation-theme=light] .styles-module__settingsBackButton___fflll {
  color: rgba(0, 0, 0, 0.85);
  border-bottom-color: rgba(0, 0, 0, 0.08);
}

.styles-module__automationHeader___Avra9 {
  display: flex;
  align-items: center;
  gap: 0.125rem;
  font-size: 0.8125rem;
  font-weight: 400;
  color: #fff;
}
[data-agentation-theme=light] .styles-module__automationHeader___Avra9 {
  color: rgba(0, 0, 0, 0.85);
}

.styles-module__automationDescription___vFTmJ {
  font-size: 0.6875rem;
  font-weight: 300;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 2px;
  line-height: 14px;
}
[data-agentation-theme=light] .styles-module__automationDescription___vFTmJ {
  color: rgba(0, 0, 0, 0.5);
}

.styles-module__learnMoreLink___cG7OI {
  color: rgba(255, 255, 255, 0.8);
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-decoration-color: rgba(255, 255, 255, 0.2);
  text-underline-offset: 2px;
  transition: color 0.15s ease;
}
.styles-module__learnMoreLink___cG7OI:hover {
  color: #fff;
}
[data-agentation-theme=light] .styles-module__learnMoreLink___cG7OI {
  color: rgba(0, 0, 0, 0.6);
  text-decoration-color: rgba(0, 0, 0, 0.2);
}
[data-agentation-theme=light] .styles-module__learnMoreLink___cG7OI:hover {
  color: rgba(0, 0, 0, 0.85);
}

.styles-module__autoSendContainer___VpkXk {
  display: flex;
  align-items: center;
}

.styles-module__autoSendLabel___ngNdC {
  padding-inline-end: 8px;
  font-size: 11px;
  font-weight: 400;
  color: rgba(255, 255, 255, 0.4);
  transition: color 0.15s, opacity 0.15s;
  cursor: pointer;
}
.styles-module__autoSendLabel___ngNdC.styles-module__active___dpAhM {
  color: #66b8ff;
  color: color(display-p3 0.4 0.72 1);
}
[data-agentation-theme=light] .styles-module__autoSendLabel___ngNdC {
  color: rgba(0, 0, 0, 0.4);
}
[data-agentation-theme=light] .styles-module__autoSendLabel___ngNdC.styles-module__active___dpAhM {
  color: var(--agentation-color-blue);
}
.styles-module__autoSendLabel___ngNdC.styles-module__disabled___9AZYS {
  opacity: 0.3;
  cursor: not-allowed;
}

.styles-module__mcpStatusDot___8AMxP {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.styles-module__mcpStatusDot___8AMxP.styles-module__connecting___QEO1r {
  background-color: var(--agentation-color-yellow);
  animation: styles-module__mcpPulse___5Q3Jj 1.5s infinite;
}
.styles-module__mcpStatusDot___8AMxP.styles-module__connected___WyFkx {
  background-color: var(--agentation-color-green);
  animation: styles-module__mcpPulse___5Q3Jj 2.5s ease-in-out infinite;
}
.styles-module__mcpStatusDot___8AMxP.styles-module__disconnected___mvmvQ {
  background-color: var(--agentation-color-red);
  animation: styles-module__mcpPulseError___VHxhx 2s infinite;
}

.styles-module__mcpNavIndicator___auBHI {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.styles-module__mcpNavIndicator___auBHI.styles-module__connected___WyFkx {
  background-color: var(--agentation-color-green);
  animation: styles-module__mcpPulse___5Q3Jj 2.5s ease-in-out infinite;
}
.styles-module__mcpNavIndicator___auBHI.styles-module__connecting___QEO1r {
  background-color: var(--agentation-color-yellow);
  animation: styles-module__mcpPulse___5Q3Jj 1.5s ease-in-out infinite;
}

.styles-module__webhookUrlInput___WDDDC {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 60px;
  box-sizing: border-box;
  margin-top: 11px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  font-family: inherit;
  font-size: 0.75rem;
  font-weight: 400;
  color: #fff;
  outline: none;
  resize: none;
  user-select: text;
  transition: border-color 0.15s ease, background-color 0.15s ease, box-shadow 0.15s ease;
}
.styles-module__webhookUrlInput___WDDDC::placeholder {
  color: rgba(255, 255, 255, 0.3);
}
.styles-module__webhookUrlInput___WDDDC:focus {
  border-color: rgba(255, 255, 255, 0.3);
  background: rgba(255, 255, 255, 0.08);
}
[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC {
  border-color: rgba(0, 0, 0, 0.1);
  background: rgba(0, 0, 0, 0.03);
  color: rgba(0, 0, 0, 0.85);
}
[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC::placeholder {
  color: rgba(0, 0, 0, 0.3);
}
[data-agentation-theme=light] .styles-module__webhookUrlInput___WDDDC:focus {
  border-color: rgba(0, 0, 0, 0.25);
  background: rgba(0, 0, 0, 0.05);
}

[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- {
  background: #fff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08), 0 4px 16px rgba(0, 0, 0, 0.06), 0 0 0 1px rgba(0, 0, 0, 0.04);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn-::before {
  background: linear-gradient(to right, #fff 0%, transparent 100%);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn-::after {
  background: linear-gradient(to left, #fff 0%, transparent 100%);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsHeader___Fn1DP {
  border-bottom-color: rgba(0, 0, 0, 0.08);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsBrand___OoKlM {
  color: #E5484D;
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsVersion___rXmL9 {
  color: rgba(0, 0, 0, 0.4);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsSection___n5V-4 {
  border-top-color: rgba(0, 0, 0, 0.08);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__settingsLabel___VCVOQ {
  color: rgba(0, 0, 0, 0.5);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleButton___XMBx3 {
  color: rgba(0, 0, 0, 0.85);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY {
  background: rgba(0, 0, 0, 0.2);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__cycleDot___zgSXY.styles-module__active___dpAhM {
  background: rgba(0, 0, 0, 0.7);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8 {
  color: rgba(0, 0, 0, 0.85);
}
[data-agentation-theme=light] .styles-module__settingsPanel___qNkn- .styles-module__dropdownButton___mKHe8:hover {
  background: rgba(0, 0, 0, 0.05);
}

.styles-module__checkboxField___ZrSqv:not(:first-child) {
  margin-top: 8px;
}

.styles-module__divider___h6Yux {
  margin-block: 8px;
  width: 100%;
  height: 1px;
  background-color: rgba(26, 26, 26, 0.07);
}
[data-agentation-theme=dark] .styles-module__divider___h6Yux {
  background-color: rgba(255, 255, 255, 0.07);
}`,lx={settingsPanel:"styles-module__settingsPanel___qNkn-",settingsHeader:"styles-module__settingsHeader___Fn1DP",settingsBrand:"styles-module__settingsBrand___OoKlM",settingsBrandSlash:"styles-module__settingsBrandSlash___Q-AU9",settingsVersion:"styles-module__settingsVersion___rXmL9",settingsSection:"styles-module__settingsSection___n5V-4",settingsLabel:"styles-module__settingsLabel___VCVOQ",cycleButton:"styles-module__cycleButton___XMBx3",cycleDot:"styles-module__cycleDot___zgSXY",dropdownButton:"styles-module__dropdownButton___mKHe8",sliderLabel:"styles-module__sliderLabel___6K5v1",slider:"styles-module__slider___v5z-c",themeToggle:"styles-module__themeToggle___3imlT",enter:"styles-module__enter___wginS",exit:"styles-module__exit___A4iJc",settingsOption:"styles-module__settingsOption___JoyH-",selected:"styles-module__selected___k1-Vq",settingsPanelContainer:"styles-module__settingsPanelContainer___5it-H",settingsPage:"styles-module__settingsPage___BMn-3",slideLeft:"styles-module__slideLeft___qUvW4",automationsPage:"styles-module__automationsPage___N7By0",slideIn:"styles-module__slideIn___uXDSu",themeIconWrapper:"styles-module__themeIconWrapper___pyaYa",themeIcon:"styles-module__themeIcon___w7lAm",themeIconIn:"styles-module__themeIconIn___qUWMV",settingsSectionGrow:"styles-module__settingsSectionGrow___eZTRw",settingsRow:"styles-module__settingsRow___y-tDE",settingsRowMarginTop:"styles-module__settingsRowMarginTop___uLpGb",settingsRowDisabled:"styles-module__settingsRowDisabled___ydl3Q",cycleButtonText:"styles-module__cycleButtonText___mbbnD",cycleTextIn:"styles-module__cycleTextIn___VBNTi",cycleDots:"styles-module__cycleDots___ehp6i",active:"styles-module__active___dpAhM",colorOptions:"styles-module__colorOptions___pbxZx",colorOption:"styles-module__colorOption___Co955",settingsNavLink:"styles-module__settingsNavLink___uYIwM",settingsNavLinkRight:"styles-module__settingsNavLinkRight___XBUzC",settingsBackButton:"styles-module__settingsBackButton___fflll",automationHeader:"styles-module__automationHeader___Avra9",automationDescription:"styles-module__automationDescription___vFTmJ",learnMoreLink:"styles-module__learnMoreLink___cG7OI",autoSendContainer:"styles-module__autoSendContainer___VpkXk",autoSendLabel:"styles-module__autoSendLabel___ngNdC",disabled:"styles-module__disabled___9AZYS",mcpStatusDot:"styles-module__mcpStatusDot___8AMxP",connecting:"styles-module__connecting___QEO1r",mcpPulse:"styles-module__mcpPulse___5Q3Jj",connected:"styles-module__connected___WyFkx",disconnected:"styles-module__disconnected___mvmvQ",mcpPulseError:"styles-module__mcpPulseError___VHxhx",mcpNavIndicator:"styles-module__mcpNavIndicator___auBHI",webhookUrlInput:"styles-module__webhookUrlInput___WDDDC",checkboxField:"styles-module__checkboxField___ZrSqv",divider:"styles-module__divider___h6Yux",scaleIn:"styles-module__scaleIn___QpQ8E"};if(typeof document<"u"){let e=document.getElementById("feedback-tool-styles-settings-panel-styles");e||(e=document.createElement("style"),e.id="feedback-tool-styles-settings-panel-styles",document.head.appendChild(e)),e.textContent=rx}var oe=lx;function ix({settings:e,onSettingsChange:t,isDarkMode:n,onToggleTheme:o,isDevMode:r,connectionStatus:l,endpoint:i,isVisible:s,toolbarNearBottom:a,settingsPage:m,onSettingsPageChange:p,onHideToolbar:b}){return(0,q.jsx)("div",{className:`${oe.settingsPanel} ${s?oe.enter:oe.exit}`,style:a?{bottom:"auto",top:"calc(100% + 0.5rem)"}:void 0,"data-agentation-settings-panel":!0,children:(0,q.jsxs)("div",{className:oe.settingsPanelContainer,children:[(0,q.jsxs)("div",{className:`${oe.settingsPage} ${m==="automations"?oe.slideLeft:""}`,children:[(0,q.jsxs)("div",{className:oe.settingsHeader,children:[(0,q.jsx)("a",{className:oe.settingsBrand,href:"https://agentation.com",target:"_blank",rel:"noopener noreferrer",children:(0,q.jsx)("svg",{width:"72",height:"16",viewBox:"0 0 676 151",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:(0,q.jsx)("path",{d:"M79.6666 100.561L104.863 15.5213C107.828 4.03448 99.1201 -3.00582 88.7449 1.25541L3.52015 39.6065C1.48217 40.5329 0 42.7562 0 45.1647C0 48.6848 2.77907 51.4639 6.29922 51.4639C7.22558 51.4639 8.15193 51.2786 9.07829 50.9081L93.7472 12.7422C97.2674 11.0748 93.7472 8.29572 92.6356 12.1864L67.624 97.2259C66.5123 100.931 69.4767 105.193 73.7379 105.193C76.517 105.193 79.1108 103.155 79.6666 100.561ZM663.641 100.005C665.679 107.231 677.537 104.081 675.499 96.8553L666.05 66.2856C663.456 57.7631 655.489 55.7251 648.82 61.098L618.991 86.6654C617.324 87.9623 621.029 89.815 621.214 88.1476L625.846 61.6538C626.958 55.3546 624.179 50.5375 615.841 50.5375L579.158 51.0934C576.008 51.0934 578.417 53.8724 578.417 57.022C578.417 60.1716 580.825 61.6538 583.975 61.6538L616.212 60.9127C616.397 60.9127 614.544 59.6158 614.544 59.8011L609.727 88.7034C607.875 99.6344 617.694 102.784 626.031 95.7437L655.86 70.1763L654.192 69.6205L663.641 100.005ZM571.191 89.0739C555.443 88.7034 562.298 61.4685 578.787 61.8391C594.72 62.0243 587.124 89.2592 571.191 89.0739ZM571.006 100.375C601.575 100.931 611.024 51.6492 579.158 51.0934C547.847 50.5375 540.065 99.8197 571.006 100.375ZM521.909 46.4616C525.985 46.4616 529.505 42.9414 529.505 38.6802C529.505 34.4189 525.985 31.0841 521.909 31.0841C517.833 31.0841 514.127 34.6042 514.127 38.6802C514.127 42.7562 517.648 46.4616 521.909 46.4616ZM472.256 103.525C493.192 103.71 515.98 73.3259 519.13 62.3949L509.866 60.9127C505.234 73.3259 497.638 101.672 519.871 102.043C536.545 102.228 552.479 85.3685 563.595 70.1763C564.151 69.2499 564.706 68.1383 564.706 66.8414C564.706 63.6918 563.965 61.098 560.816 61.098C558.963 61.098 557.296 62.0243 556.184 63.5065C546.365 77.0313 530.802 90.9266 522.094 90.7414C511.904 90.5561 517.462 71.4732 519.871 64.9887C523.391 55.7251 512.831 53.5019 509.681 60.9127C506.531 68.6941 488.19 92.4088 475.035 92.2235C467.439 92.0383 464.29 83.8863 472.441 59.9864L486.707 17.7445C487.634 14.4097 485.41 10.519 481.334 10.519C478.741 10.519 476.517 12.1864 475.962 14.4097L461.696 56.4662C451.506 86.4801 455.211 103.155 472.256 103.525ZM447.43 42.5709L496.527 41.4593C499.306 41.4593 501.529 39.0507 501.529 36.2717C501.529 33.3073 499.306 31.0841 496.341 31.0841L447.245 32.1957C444.466 32.1957 442.242 34.4189 442.242 37.3833C442.242 40.1624 444.466 42.5709 447.43 42.5709ZM422.974 106.304C435.387 106.489 457.249 94.8173 472.441 53.8724C473.553 50.7228 472.071 48.3143 468.365 48.3143C466.142 48.3143 464.29 49.6112 463.548 51.6492C450.394 87.2212 431.682 96.1142 424.456 95.929C419.454 95.929 417.972 93.3352 418.713 85.5538C419.454 78.1429 410.376 74.9933 406.114 81.1073C401.297 87.777 394.442 94.2615 385.549 94.0763C370.172 93.891 376.471 67.0267 399.815 67.3972C408.338 67.5825 414.452 71.4732 417.045 76.6608C417.786 78.3282 419.454 79.6251 421.492 79.6251C424.271 79.6251 426.679 77.2166 426.679 74.4375C426.679 73.6964 426.494 72.9553 426.124 72.2143C421.862 63.6918 412.414 57.3926 400 57.2073C363.502 56.6515 353.497 104.451 383.326 104.822C397.036 105.193 410.005 94.0763 413.34 85.9243C412.599 86.8507 408.338 86.6654 408.523 84.4422C407.411 97.4111 410.931 106.119 422.974 106.304ZM335.897 104.266C335.897 115.012 347.569 117.606 347.569 103.34C347.569 89.0739 358.5 54.4282 361.464 45.1647L396.666 43.6825C405.929 43.1267 404.262 33.1221 397.036 33.3073L364.984 34.4189L368.875 22.7469C369.801 20.1531 370.542 17.9298 370.542 16.2624C370.542 13.4833 368.504 11.8159 365.911 11.8159C362.946 11.8159 360.352 12.7422 357.573 21.0794L352.942 35.16L330.153 36.0864C326.263 36.4569 323.483 38.1244 323.483 41.6445C323.483 45.5352 326.448 47.0174 330.709 46.8321L349.421 45.9058C345.901 56.6515 335.897 90.7414 335.897 104.266ZM186.939 78.6988C193.979 56.4662 212.877 54.984 212.877 62.9507C212.877 68.3236 203.984 77.0313 186.939 78.6988ZM113.942 150.955C142.844 152.437 159.704 111.492 160.63 80.5515C161.556 73.3259 153.96 70.3616 148.773 75.7344C141.918 83.1453 129.505 93.1499 119.685 93.1499C103.011 93.1499 116.165 59.8011 143.956 59.8011C149.514 59.8011 153.59 61.6538 156.184 64.0623C160.815 68.3236 170.82 62.0243 165.818 56.0957C161.927 51.4639 155.072 48.129 144.882 48.129C102.455 48.129 83.7426 105.007 116.721 105.007C134.692 105.007 151.367 88.3329 155.257 82.7747C154.516 83.5158 149.329 81.2925 149.699 79.4398L149.143 83.5158C148.958 107.045 134.322 141.506 116.536 139.838C113.386 139.468 112.089 137.43 112.089 134.836C112.089 128.907 122.094 119.273 145.067 113.53C159.518 109.824 152.293 101.487 143.4 104.081C111.163 113.53 99.6759 127.425 99.6759 137.8C99.6759 145.026 105.605 150.584 113.942 150.955ZM194.72 109.454C214.359 109.454 239 95.3732 251.228 77.9577C250.301 82.96 246.596 96.8553 246.596 101.487C246.596 110.01 254.748 109.454 261.232 102.784L288.097 75.5491L290.32 85.7391C293.284 99.4491 299.213 104.822 308.847 104.822C326.263 104.822 342.196 85.7391 349.421 74.8081L344.049 63.6918C339.787 74.8081 321.631 92.5941 311.626 92.5941C306.994 92.5941 304.771 89.815 303.289 83.7011L300.325 71.2879C297.916 60.7275 289.023 58.3189 279.018 68.1383L261.788 84.8127L264.382 69.991C266.235 59.2453 255.674 58.1337 250.116 65.915C241.779 77.0313 216.767 97.7817 196.387 97.7817C187.865 97.7817 185.456 93.7057 185.456 88.3329C230.848 84.998 239.185 47.2027 208.986 47.2027C172.858 47.2027 157.11 109.454 194.72 109.454Z",fill:"currentColor"})})}),(0,q.jsxs)("p",{className:oe.settingsVersion,children:["v","3.0.2"]}),(0,q.jsx)("button",{className:oe.themeToggle,onClick:o,title:n?"Switch to light mode":"Switch to dark mode",children:(0,q.jsx)("span",{className:oe.themeIconWrapper,children:(0,q.jsx)("span",{className:oe.themeIcon,children:n?(0,q.jsx)(iy,{size:20}):(0,q.jsx)(sy,{size:20})},n?"sun":"moon")})})]}),(0,q.jsx)("div",{className:oe.divider}),(0,q.jsxs)("div",{className:oe.settingsSection,children:[(0,q.jsxs)("div",{className:oe.settingsRow,children:[(0,q.jsxs)("div",{className:oe.settingsLabel,children:["Output Detail",(0,q.jsx)(Nr,{content:"Controls how much detail is included in the copied output"})]}),(0,q.jsxs)("button",{className:oe.cycleButton,onClick:()=>{let $=(Ti.findIndex(C=>C.value===e.outputDetail)+1)%Ti.length;t({outputDetail:Ti[$].value})},children:[(0,q.jsx)("span",{className:oe.cycleButtonText,children:Ti.find(y=>y.value===e.outputDetail)?.label},e.outputDetail),(0,q.jsx)("span",{className:oe.cycleDots,children:Ti.map(y=>(0,q.jsx)("span",{className:`${oe.cycleDot} ${e.outputDetail===y.value?oe.active:""}`},y.value))})]})]}),(0,q.jsxs)("div",{className:`${oe.settingsRow} ${oe.settingsRowMarginTop} ${r?"":oe.settingsRowDisabled}`,children:[(0,q.jsxs)("div",{className:oe.settingsLabel,children:["React Components",(0,q.jsx)(Nr,{content:r?"Include React component names in annotations":"Disabled \u2014 production builds minify component names, making detection unreliable. Use in development mode."})]}),(0,q.jsx)(bu,{checked:r&&e.reactEnabled,onChange:y=>t({reactEnabled:y.target.checked}),disabled:!r})]}),(0,q.jsxs)("div",{className:`${oe.settingsRow} ${oe.settingsRowMarginTop}`,children:[(0,q.jsxs)("div",{className:oe.settingsLabel,children:["Hide Until Restart",(0,q.jsx)(Nr,{content:"Hides the toolbar until you open a new tab"})]}),(0,q.jsx)(bu,{checked:!1,onChange:y=>{y.target.checked&&b()}})]})]}),(0,q.jsx)("div",{className:oe.divider}),(0,q.jsxs)("div",{className:oe.settingsSection,children:[(0,q.jsx)("div",{className:`${oe.settingsLabel} ${oe.settingsLabelMarker}`,children:"Marker Color"}),(0,q.jsx)("div",{className:oe.colorOptions,children:Pi.map(y=>(0,q.jsx)("button",{className:`${oe.colorOption} ${e.annotationColorId===y.id?oe.selected:""}`,style:{"--swatch":y.srgb,"--swatch-p3":y.p3},onClick:()=>t({annotationColorId:y.id}),title:y.label,type:"button"},y.id))})]}),(0,q.jsx)("div",{className:oe.divider}),(0,q.jsxs)("div",{className:oe.settingsSection,children:[(0,q.jsx)(mp,{className:"checkbox-field",label:"Clear on copy/send",checked:e.autoClearAfterCopy,onChange:y=>t({autoClearAfterCopy:y.target.checked}),tooltip:"Automatically clear annotations after copying"}),(0,q.jsx)(mp,{className:oe.checkboxField,label:"Block page interactions",checked:e.blockInteractions,onChange:y=>t({blockInteractions:y.target.checked})})]}),(0,q.jsx)("div",{className:oe.divider}),(0,q.jsxs)("button",{className:oe.settingsNavLink,onClick:()=>p("automations"),children:[(0,q.jsx)("span",{children:"Manage MCP & Webhooks"}),(0,q.jsxs)("span",{className:oe.settingsNavLinkRight,children:[i&&l!=="disconnected"&&(0,q.jsx)("span",{className:`${oe.mcpNavIndicator} ${oe[l]}`}),(0,q.jsx)("svg",{width:"16",height:"16",viewBox:"0 0 16 16",fill:"none",xmlns:"http://www.w3.org/2000/svg",children:(0,q.jsx)("path",{d:"M7.5 12.5L12 8L7.5 3.5",stroke:"currentColor",strokeWidth:"1.5",strokeLinecap:"round",strokeLinejoin:"round"})})]})]})]}),(0,q.jsxs)("div",{className:`${oe.settingsPage} ${oe.automationsPage} ${m==="automations"?oe.slideIn:""}`,children:[(0,q.jsxs)("button",{className:oe.settingsBackButton,onClick:()=>p("main"),children:[(0,q.jsx)(dy,{size:16}),(0,q.jsx)("span",{children:"Manage MCP & Webhooks"})]}),(0,q.jsx)("div",{className:oe.divider}),(0,q.jsxs)("div",{className:oe.settingsSection,children:[(0,q.jsxs)("div",{className:oe.settingsRow,children:[(0,q.jsxs)("span",{className:oe.automationHeader,children:["MCP Connection",(0,q.jsx)(Nr,{content:"Connect via Model Context Protocol to let AI agents like Claude Code receive annotations in real-time."})]}),i&&(0,q.jsx)("div",{className:`${oe.mcpStatusDot} ${oe[l]}`,title:l==="connected"?"Connected":l==="connecting"?"Connecting...":"Disconnected"})]}),(0,q.jsxs)("p",{className:oe.automationDescription,style:{paddingBottom:6},children:["MCP connection allows agents to receive and act on annotations."," ",(0,q.jsx)("a",{href:"https://agentation.dev/mcp",target:"_blank",rel:"noopener noreferrer",className:oe.learnMoreLink,children:"Learn more"})]})]}),(0,q.jsx)("div",{className:oe.divider}),(0,q.jsxs)("div",{className:`${oe.settingsSection} ${oe.settingsSectionGrow}`,children:[(0,q.jsxs)("div",{className:oe.settingsRow,children:[(0,q.jsxs)("span",{className:oe.automationHeader,children:["Webhooks",(0,q.jsx)(Nr,{content:"Send annotation data to any URL endpoint when annotations change. Useful for custom integrations."})]}),(0,q.jsxs)("div",{className:oe.autoSendContainer,children:[(0,q.jsx)("label",{htmlFor:"agentation-auto-send",className:`${oe.autoSendLabel} ${e.webhooksEnabled?oe.active:""} ${e.webhookUrl?"":oe.disabled}`,children:"Auto-Send"}),(0,q.jsx)(bu,{id:"agentation-auto-send",checked:e.webhooksEnabled,onChange:y=>t({webhooksEnabled:y.target.checked}),disabled:!e.webhookUrl})]})]}),(0,q.jsx)("p",{className:oe.automationDescription,children:"The webhook URL will receive live annotation changes and annotation data."}),(0,q.jsx)("textarea",{className:oe.webhookUrlInput,placeholder:"Webhook URL",value:e.webhookUrl,onKeyDown:y=>y.stopPropagation(),onChange:y=>t({webhookUrl:y.target.value})})]})]})]})})}function ku(e,t="filtered"){let{name:n,path:o}=wl(e);if(t==="off")return{name:n,elementName:n,path:o,reactComponents:null};let r=P2(e,{mode:t});return{name:r.path?`${r.path} ${n}`:n,elementName:n,path:o,reactComponents:r.path}}var gp=!1,Cu={outputDetail:"standard",autoClearAfterCopy:!1,annotationColorId:"blue",blockInteractions:!0,reactEnabled:!0,markerClickBehavior:"edit",webhookUrl:"",webhooksEnabled:!0},ho=e=>{if(!e||!e.trim())return!1;try{let t=new URL(e.trim());return t.protocol==="http:"||t.protocol==="https:"}catch{return!1}},sx={compact:"off",standard:"filtered",detailed:"smart",forensic:"all"},Pi=[{id:"indigo",label:"Indigo",srgb:"#6155F5",p3:"color(display-p3 0.38 0.33 0.96)"},{id:"blue",label:"Blue",srgb:"#0088FF",p3:"color(display-p3 0.00 0.53 1.00)"},{id:"cyan",label:"Cyan",srgb:"#00C3D0",p3:"color(display-p3 0.00 0.76 0.82)"},{id:"green",label:"Green",srgb:"#34C759",p3:"color(display-p3 0.20 0.78 0.35)"},{id:"yellow",label:"Yellow",srgb:"#FFCC00",p3:"color(display-p3 1.00 0.80 0.00)"},{id:"orange",label:"Orange",srgb:"#FF8D28",p3:"color(display-p3 1.00 0.55 0.16)"},{id:"red",label:"Red",srgb:"#FF383C",p3:"color(display-p3 1.00 0.22 0.24)"}],ax=()=>{if(typeof document>"u"||document.getElementById("agentation-color-tokens"))return;let e=document.createElement("style");e.id="agentation-color-tokens",e.textContent=[...Pi.map(t=>`
      [data-agentation-accent="${t.id}"] {
        --agentation-color-accent: ${t.srgb};
      }

      @supports (color: color(display-p3 0 0 0)) {
        [data-agentation-accent="${t.id}"] {
          --agentation-color-accent: ${t.p3};
        }
      }
    `),`:root {
      ${Pi.map(t=>`--agentation-color-${t.id}: ${t.srgb};`).join(`
`)}
    }`,`@supports (color: color(display-p3 0 0 0)) {
      :root {
        ${Pi.map(t=>`--agentation-color-${t.id}: ${t.p3};`).join(`
`)}
      }
    }`].join(""),document.head.appendChild(e)};ax();function Lr(e,t){let n=document.elementFromPoint(e,t);if(!n)return null;for(;n?.shadowRoot;){let o=n.shadowRoot.elementFromPoint(e,t);if(!o||o===n)break;n=o}return n}function Su(e){let t=e;for(;t&&t!==document.body;){let o=window.getComputedStyle(t).position;if(o==="fixed"||o==="sticky")return!0;t=t.parentElement}return!1}function Ir(e){return e.status!=="resolved"&&e.status!=="dismissed"}function Na(e){let t=Tu(e),n=t.found?t:Y2(e);if(n.found&&n.source)return U2(n.source,"path")}function zp({demoAnnotations:e,demoDelay:t=1e3,enableDemoMode:n=!1,onAnnotationAdd:o,onAnnotationDelete:r,onAnnotationUpdate:l,onAnnotationsClear:i,onCopy:s,onSubmit:a,copyToClipboard:m=!0,endpoint:p,sessionId:b,onSessionCreated:y,webhookUrl:$,className:C}={}){let[I,E]=(0,M.useState)(!1),[f,g]=(0,M.useState)([]),[w,N]=(0,M.useState)(!0),[H,V]=(0,M.useState)(()=>v2()),[D,G]=(0,M.useState)(!1),ye=(0,M.useRef)(null);(0,M.useEffect)(()=>{let u=x=>{let v=ye.current;v&&v.contains(x.target)&&x.stopPropagation()},h=["mousedown","click","pointerdown"];return h.forEach(x=>document.body.addEventListener(x,u)),()=>{h.forEach(x=>document.body.removeEventListener(x,u))}},[]);let[Z,he]=(0,M.useState)(!1),[Ge,it]=(0,M.useState)(!1),[Re,We]=(0,M.useState)(null),[Ee,Ke]=(0,M.useState)({x:0,y:0}),[X,me]=(0,M.useState)(null),[Ue,Mt]=(0,M.useState)(!1),[cn,en]=(0,M.useState)("idle"),[$o,Sn]=(0,M.useState)(!1),[Ro,On]=(0,M.useState)(!1),[mo,To]=(0,M.useState)(null),[rr,gn]=(0,M.useState)(null),[An,dn]=(0,M.useState)([]),[eo,to]=(0,M.useState)(null),[Tr,Wn]=(0,M.useState)(null),[Te,U]=(0,M.useState)(null),[ue,xe]=(0,M.useState)(null),[$e,ve]=(0,M.useState)([]),[qe,et]=(0,M.useState)(0),[Ye,ze]=(0,M.useState)(!1),[pe,S]=(0,M.useState)(!1),[L,B]=(0,M.useState)(!1),[O,J]=(0,M.useState)(!1),[le,F]=(0,M.useState)(!1),[ie,Se]=(0,M.useState)("main"),[Fe,Ze]=(0,M.useState)(!1),[se,tt]=(0,M.useState)(!1),[Pe,Le]=(0,M.useState)(!1),[ae,nt]=(0,M.useState)([]),[je,Ie]=(0,M.useState)(null),Xe=(0,M.useRef)(!1),[we,ut]=(0,M.useState)(!1),[Ft,Mn]=(0,M.useState)(!1),[no,un]=(0,M.useState)(1),[go,zi]=(0,M.useState)("new-page"),[It,yo]=(0,M.useState)(""),[Oi,Xp]=(0,M.useState)(!1),[Ce,En]=(0,M.useState)(null),Pa=(0,M.useRef)(!1),Da=(0,M.useRef)({rearrange:null,placements:[]}),lr=(0,M.useRef)({rearrange:null,placements:[]}),[Qp,Au]=(0,M.useState)(0),[Vp,Kp]=(0,M.useState)(0),[Gp,Ba]=(0,M.useState)(0),[qp,Wu]=(0,M.useState)(0),Sl=(0,M.useRef)(new Set),Ai=(0,M.useRef)(new Set),Fn=(0,M.useRef)(null),Wi=(0,M.useRef)(),Fu=se&&I&&!Pe&&we;(0,M.useEffect)(()=>{if(Fu){Mn(!1);let u=vl(()=>{Mn(!0)});return()=>cancelAnimationFrame(u)}else Mn(!1)},[Fu]);let Ml=(0,M.useRef)(new Map),El=(0,M.useRef)(new Map),Ll=(0,M.useRef)(),[jn,za]=(0,M.useState)(!1),[Ln,Zp]=(0,M.useState)([]),Jp=(0,M.useRef)(Ln);Jp.current=Ln;let[ju,ux]=(0,M.useState)(null),Oa=(0,M.useRef)(null),_x=(0,M.useRef)(!1),fx=(0,M.useRef)([]),hx=(0,M.useRef)(0),px=(0,M.useRef)(null),mx=(0,M.useRef)(null),gx=(0,M.useRef)(1),[Hu,Uu]=(0,M.useState)(!1),Pr=(0,M.useRef)(null),[Pt,Dr]=(0,M.useState)([]),oo=(0,M.useRef)({cmd:!1,shift:!1}),Vt=()=>{Ze(!0)},em=()=>{Ze(!1)},tm=()=>{Hu||(Pr.current=fe(()=>Uu(!0),850))},nm=()=>{Pr.current&&(clearTimeout(Pr.current),Pr.current=null),Uu(!1),em()};(0,M.useEffect)(()=>()=>{Pr.current&&clearTimeout(Pr.current)},[]);let[De,om]=(0,M.useState)(()=>{try{let u=JSON.parse(localStorage.getItem("feedback-toolbar-settings")??"");return{...Cu,...u,annotationColorId:Pi.find(h=>h.id===u.annotationColorId)?u.annotationColorId:Cu.annotationColorId}}catch{return Cu}}),[ro,Yu]=(0,M.useState)(!0),[Xu,Qu]=(0,M.useState)(!1),rm=()=>{ye.current?.classList.add(A.disableTransitions),Yu(u=>!u),vl(()=>{ye.current?.classList.remove(A.disableTransitions)})},Vu=!1,ir=Vu&&De.reactEnabled?sx[De.outputDetail]:"off",[zt,Aa]=(0,M.useState)(b??null),Ku=(0,M.useRef)(!1),[Hn,sr]=(0,M.useState)(p?"connecting":"disconnected"),[xt,Wa]=(0,M.useState)(null),[ar,Gu]=(0,M.useState)(!1),[Br,qu]=(0,M.useState)(null),Fa=(0,M.useRef)(!1),[Zu,Il]=(0,M.useState)(new Set),[Ju,Fi]=(0,M.useState)(new Set),[Nl,ji]=(0,M.useState)(!1),[lm,zr]=(0,M.useState)(!1),[xo,e_]=(0,M.useState)(!1),Or=(0,M.useRef)(null),lo=(0,M.useRef)(null),$l=(0,M.useRef)(null),Rl=(0,M.useRef)(null),Hi=(0,M.useRef)(!1),t_=(0,M.useRef)(0),Ui=(0,M.useRef)(null),n_=(0,M.useRef)(null),ja=8,im=50,o_=(0,M.useRef)(null),r_=(0,M.useRef)(null),Tl=(0,M.useRef)(null),ge=typeof window<"u"?window.location.pathname:"/";(0,M.useEffect)(()=>{if(O)F(!0);else{Ze(!1),Se("main");let u=fe(()=>F(!1),0);return()=>clearTimeout(u)}},[O]);let Ha=I&&w&&!se;(0,M.useEffect)(()=>{if(Ha){it(!1),he(!0),Il(new Set);let u=fe(()=>{Il(h=>{let x=new Set(h);return f.forEach(v=>x.add(v.id)),x})},350);return()=>clearTimeout(u)}else if(Z){it(!0);let u=fe(()=>{he(!1),it(!1)},250);return()=>clearTimeout(u)}},[Ha]),(0,M.useEffect)(()=>{S(!0),et(window.scrollY);let u=gu(ge);g(u.filter(Ir)),gp||(Qu(!0),gp=!0,fe(()=>Qu(!1),750));try{let h=localStorage.getItem("feedback-toolbar-theme");h!==null&&Yu(h==="dark")}catch{}try{let h=localStorage.getItem("feedback-toolbar-position");if(h){let x=JSON.parse(h);typeof x.x=="number"&&typeof x.y=="number"&&Wa(x)}}catch{}},[ge]),(0,M.useEffect)(()=>{pe&&localStorage.setItem("feedback-toolbar-settings",JSON.stringify(De))},[De,pe]),(0,M.useEffect)(()=>{pe&&localStorage.setItem("feedback-toolbar-theme",ro?"dark":"light")},[ro,pe]);let l_=(0,M.useRef)(!1);(0,M.useEffect)(()=>{let u=l_.current;l_.current=ar,u&&!ar&&xt&&pe&&localStorage.setItem("feedback-toolbar-position",JSON.stringify(xt))},[ar,xt,pe]),(0,M.useEffect)(()=>{if(!p||!pe||Ku.current)return;Ku.current=!0,sr("connecting"),(async()=>{try{let h=y2(ge),x=b||h,v=!1;if(x)try{let k=await ap(p,x);Aa(k.id),sr("connected"),yu(ge,k.id),v=!0;let P=gu(ge),Y=new Set(k.annotations.map(re=>re.id)),K=P.filter(re=>!Y.has(re.id));if(K.length>0){let ce=`${typeof window<"u"?window.location.origin:""}${ge}`,Me=(await Promise.allSettled(K.map(_e=>yl(p,k.id,{..._e,sessionId:k.id,url:ce})))).map((_e,te)=>_e.status==="fulfilled"?_e.value:(console.warn("[Agentation] Failed to sync annotation:",_e.reason),K[te])),Oe=[...k.annotations,...Me];g(Oe.filter(Ir)),Ni(ge,Oe.filter(Ir),k.id)}else g(k.annotations.filter(Ir)),Ni(ge,k.annotations.filter(Ir),k.id)}catch(k){console.warn("[Agentation] Could not join session, creating new:",k),x2(ge)}if(!v){let k=typeof window<"u"?window.location.href:"/",P=await xu(p,k);Aa(P.id),sr("connected"),yu(ge,P.id),y?.(P.id);let Y=d2(),K=typeof window<"u"?window.location.origin:"",re=[];for(let[ce,de]of Y){let Me=de.filter(te=>!te._syncedTo);if(Me.length===0)continue;let Oe=`${K}${ce}`,_e=ce===ge;re.push((async()=>{try{let te=_e?P:await xu(p,Oe),Ot=(await Promise.allSettled(Me.map(ot=>yl(p,te.id,{...ot,sessionId:te.id,url:Oe})))).map((ot,$t)=>ot.status==="fulfilled"?ot.value:(console.warn("[Agentation] Failed to sync annotation:",ot.reason),Me[$t])).filter(Ir);if(Ni(ce,Ot,te.id),_e){let ot=new Set(Me.map($t=>$t.id));g($t=>{let be=$t.filter(Ne=>!ot.has(Ne.id));return[...Ot,...be]})}}catch(te){console.warn(`[Agentation] Failed to sync annotations for ${ce}:`,te)}})())}await Promise.allSettled(re)}}catch(h){sr("disconnected"),console.warn("[Agentation] Failed to initialize session, using local storage:",h)}})()},[p,b,pe,y,ge]),(0,M.useEffect)(()=>{if(!p||!pe)return;let u=async()=>{try{(await fetch(`${p}/health`)).ok?sr("connected"):sr("disconnected")}catch{sr("disconnected")}};u();let h=fy(u,1e4);return()=>clearInterval(h)},[p,pe]),(0,M.useEffect)(()=>{if(!p||!pe||!zt)return;let u=new EventSource(`${p}/sessions/${zt}/events`),h=["resolved","dismissed"],x=v=>{try{let k=JSON.parse(v.data);if(h.includes(k.payload?.status)){let P=k.payload.id,Y=k.payload.kind;if(Y==="placement"){for(let[K,re]of Ml.current)if(re===P){Ml.current.delete(K),nt(ce=>ce.filter(de=>de.id!==K));break}}else if(Y==="rearrange"){for(let[K,re]of El.current)if(re===P){El.current.delete(K),En(ce=>{if(!ce)return null;let de=ce.sections.filter(Me=>Me.id!==K);return de.length===0?null:{...ce,sections:de}});break}}else Fi(K=>new Set(K).add(P)),fe(()=>{g(K=>K.filter(re=>re.id!==P)),Fi(K=>{let re=new Set(K);return re.delete(P),re})},150)}}catch{}};return u.addEventListener("annotation.updated",x),()=>{u.removeEventListener("annotation.updated",x),u.close()}},[p,pe,zt]),(0,M.useEffect)(()=>{if(!p||!pe)return;let u=n_.current==="disconnected",h=Hn==="connected";n_.current=Hn,u&&h&&(async()=>{try{let v=gu(ge);if(v.length===0)return;let P=`${typeof window<"u"?window.location.origin:""}${ge}`,Y=zt,K=[];if(Y)try{K=(await ap(p,Y)).annotations}catch{Y=null}Y||(Y=(await xu(p,P)).id,Aa(Y),yu(ge,Y));let re=new Set(K.map(de=>de.id)),ce=v.filter(de=>!re.has(de.id));if(ce.length>0){let Me=(await Promise.allSettled(ce.map(te=>yl(p,Y,{...te,sessionId:Y,url:P})))).map((te,Nt)=>te.status==="fulfilled"?te.value:(console.warn("[Agentation] Failed to sync annotation on reconnect:",te.reason),ce[Nt])),_e=[...K,...Me].filter(Ir);g(_e),Ni(ge,_e,Y)}}catch(v){console.warn("[Agentation] Failed to sync on reconnect:",v)}})()},[Hn,p,pe,zt,ge]);let sm=(0,M.useCallback)(()=>{D||(G(!0),J(!1),E(!1),fe(()=>{w2(!0),V(!0),G(!1)},400))},[D]);(0,M.useEffect)(()=>{if(!n||!pe||!e||e.length===0||f.length>0)return;let u=[];return u.push(fe(()=>{E(!0)},t-200)),e.forEach((h,x)=>{let v=t+x*300;u.push(fe(()=>{let k=document.querySelector(h.selector);if(!k)return;let P=k.getBoundingClientRect(),{name:Y,path:K}=wl(k),re={id:`demo-${Date.now()}-${x}`,x:(P.left+P.width/2)/window.innerWidth*100,y:P.top+P.height/2+window.scrollY,comment:h.comment,element:Y,elementPath:K,timestamp:Date.now(),selectedText:h.selectedText,boundingBox:{x:P.left,y:P.top+window.scrollY,width:P.width,height:P.height},nearbyText:Li(k),cssClasses:Ii(k)};g(ce=>[...ce,re])},v))}),()=>{u.forEach(clearTimeout)}},[n,pe,e,t]),(0,M.useEffect)(()=>{let u=()=>{et(window.scrollY),ze(!0),Tl.current&&clearTimeout(Tl.current),Tl.current=fe(()=>{ze(!1)},150)};return window.addEventListener("scroll",u,{passive:!0}),()=>{window.removeEventListener("scroll",u),Tl.current&&clearTimeout(Tl.current)}},[]),(0,M.useEffect)(()=>{pe&&f.length>0?zt?Ni(ge,f,zt):Tp(ge,f):pe&&f.length===0&&localStorage.removeItem(Ta(ge))},[f,ge,pe,zt]),(0,M.useEffect)(()=>{if(pe&&!Xe.current){Xe.current=!0;let u=u2(ge);u.length>0&&nt(u)}},[pe,ge]),(0,M.useEffect)(()=>{pe&&Xe.current&&!we&&(ae.length>0?_2(ge,ae):f2(ge))},[ae,ge,pe,we]),(0,M.useEffect)(()=>{if(pe&&!Pa.current){Pa.current=!0;let u=h2(ge);if(u){let h={...u,sections:u.sections.map(x=>({...x,currentRect:x.currentRect??{...x.originalRect}}))};En(h)}}},[pe,ge]),(0,M.useEffect)(()=>{pe&&Pa.current&&!we&&(Ce?p2(ge,Ce):m2(ge))},[Ce,ge,pe,we]);let Ua=(0,M.useRef)(!1);(0,M.useEffect)(()=>{if(pe&&!Ua.current){Ua.current=!0;let u=g2(ge);u&&(lr.current={rearrange:u.rearrange,placements:u.placements||[]},u.purpose&&yo(u.purpose))}},[pe,ge]),(0,M.useEffect)(()=>{if(!pe||!Ua.current)return;let u=lr.current;we?(Ce?.sections?.length??0)>0||ae.length>0||It?sp(ge,{rearrange:Ce,placements:ae,purpose:It}):Ea(ge):(u.rearrange?.sections?.length??0)>0||u.placements.length>0||It?sp(ge,{rearrange:u.rearrange,placements:u.placements,purpose:It}):Ea(ge)},[Ce,ae,It,we,ge,pe]),(0,M.useEffect)(()=>{se&&!Ce&&En({sections:[],originalOrder:[],detectedAt:Date.now()})},[se,Ce]),(0,M.useEffect)(()=>{if(!p||!zt)return;let u=Ml.current,h=new Set(ae.map(x=>x.id));for(let x of ae){if(u.has(x.id))continue;u.set(x.id,"");let v=typeof window<"u"?window.location.pathname+window.location.search+window.location.hash:ge;yl(p,zt,{id:x.id,x:x.x/window.innerWidth*100,y:x.y,comment:`Place ${x.type} at (${Math.round(x.x)}, ${Math.round(x.y)}), ${x.width}\xD7${x.height}px${x.text?` \u2014 "${x.text}"`:""}`,element:`[design:${x.type}]`,elementPath:"[placement]",timestamp:x.timestamp,url:v,intent:"change",severity:"important",kind:"placement",placement:{componentType:x.type,width:x.width,height:x.height,scrollY:x.scrollY,text:x.text}}).then(k=>{u.has(x.id)&&u.set(x.id,k.id)}).catch(k=>{console.warn("[Agentation] Failed to sync placement annotation:",k),u.delete(x.id)})}for(let[x,v]of u)h.has(x)||(u.delete(x),v&&or(p,v).catch(()=>{}))},[ae,p,zt,ge]),(0,M.useEffect)(()=>{if(!(!p||!zt))return Ll.current&&clearTimeout(Ll.current),Ll.current=fe(()=>{let u=El.current;if(!Ce||Ce.sections.length===0){for(let[,v]of u)v&&or(p,v).catch(()=>{});u.clear();return}let h=new Set(Ce.sections.map(v=>v.id)),x=typeof window<"u"?window.location.pathname+window.location.search+window.location.hash:ge;for(let v of Ce.sections){let k=v.originalRect,P=v.currentRect;if(!(Math.abs(k.x-P.x)>1||Math.abs(k.y-P.y)>1||Math.abs(k.width-P.width)>1||Math.abs(k.height-P.height)>1)){let re=u.get(v.id);re&&(u.delete(v.id),or(p,re).catch(()=>{}));continue}let K=u.get(v.id);K?cp(p,K,{comment:`Move ${v.label} section (${v.tagName}) \u2014 from (${Math.round(k.x)},${Math.round(k.y)}) ${Math.round(k.width)}\xD7${Math.round(k.height)} to (${Math.round(P.x)},${Math.round(P.y)}) ${Math.round(P.width)}\xD7${Math.round(P.height)}`}).catch(re=>{console.warn("[Agentation] Failed to update rearrange annotation:",re)}):(u.set(v.id,""),yl(p,zt,{id:v.id,x:P.x/window.innerWidth*100,y:P.y,comment:`Move ${v.label} section (${v.tagName}) \u2014 from (${Math.round(k.x)},${Math.round(k.y)}) ${Math.round(k.width)}\xD7${Math.round(k.height)} to (${Math.round(P.x)},${Math.round(P.y)}) ${Math.round(P.width)}\xD7${Math.round(P.height)}`,element:v.selector,elementPath:"[rearrange]",timestamp:Date.now(),url:x,intent:"change",severity:"important",kind:"rearrange",rearrange:{selector:v.selector,label:v.label,tagName:v.tagName,originalRect:k,currentRect:P}}).then(re=>{u.has(v.id)&&u.set(v.id,re.id)}).catch(re=>{console.warn("[Agentation] Failed to sync rearrange annotation:",re),u.delete(v.id)}))}for(let[v,k]of u)h.has(v)||(u.delete(v),k&&or(p,k).catch(()=>{}))},300),()=>{Ll.current&&clearTimeout(Ll.current)}},[Ce,p,zt,ge]);let Ar=(0,M.useRef)(new Map);(0,M.useLayoutEffect)(()=>{let u=Ce?.sections??[],h=new Set;if((se||Pe)&&I)for(let x of u){h.add(x.id);try{let v=document.querySelector(x.selector);if(!v)continue;if(!Ar.current.has(x.id)){let k={transform:v.style.transform,transformOrigin:v.style.transformOrigin,opacity:v.style.opacity,position:v.style.position,zIndex:v.style.zIndex,display:v.style.display},P=[],Y=v.parentElement;for(;Y&&Y!==document.body;){let re=getComputedStyle(Y);(re.overflow!=="visible"||re.overflowX!=="visible"||re.overflowY!=="visible")&&(P.push({el:Y,overflow:Y.style.overflow}),Y.style.overflow="visible"),Y=Y.parentElement}getComputedStyle(v).display==="inline"&&(v.style.display="inline-block"),Ar.current.set(x.id,{el:v,origStyles:k,ancestors:P}),v.style.transformOrigin="top left",v.style.zIndex="9999"}}catch{}}for(let[x,v]of Ar.current)if(!h.has(x)){let{el:k,origStyles:P,ancestors:Y}=v;k.style.transition="transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s cubic-bezier(0.22, 1, 0.36, 1)",k.style.transform=P.transform,k.style.transformOrigin=P.transformOrigin,k.style.opacity=P.opacity,k.style.position=P.position,k.style.zIndex=P.zIndex,Ar.current.delete(x),fe(()=>{k.style.transition="",k.style.display=P.display;for(let K of Y)K.el.style.overflow=K.overflow},450)}},[Ce,se,Pe,I]),(0,M.useEffect)(()=>()=>{for(let[,u]of Ar.current){let{el:h,origStyles:x,ancestors:v}=u;h.style.transition="transform 0.4s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.4s cubic-bezier(0.22, 1, 0.36, 1)",h.style.transform=x.transform,h.style.transformOrigin=x.transformOrigin,h.style.opacity=x.opacity,h.style.position=x.position,h.style.zIndex=x.zIndex,fe(()=>{h.style.transition="",h.style.display=x.display;for(let k of v)k.el.style.overflow=k.overflow},450)}Ar.current.clear()},[]);let Yi=(0,M.useCallback)(()=>{Le(!0),tt(!1),Ie(null),clearTimeout(Wi.current),Wi.current=fe(()=>{Le(!1)},300)},[]),i_=(0,M.useCallback)(()=>{se&&(Le(!0),tt(!1),Ie(null),clearTimeout(Wi.current),Wi.current=fe(()=>{Le(!1)},300)),E(!1)},[se]),s_=(0,M.useCallback)(()=>{L||(py(),B(!0))},[L]),Xi=(0,M.useCallback)(()=>{L&&(Qh(),B(!1))},[L]),Ya=(0,M.useCallback)(()=>{L?Xi():s_()},[L,s_,Xi]),a_=(0,M.useCallback)(()=>{if(Pt.length===0)return;let u=Pt[0],h=u.element,x=Pt.length>1,v=Pt.map(k=>k.element.getBoundingClientRect());if(x){let k={left:Math.min(...v.map(te=>te.left)),top:Math.min(...v.map(te=>te.top)),right:Math.max(...v.map(te=>te.right)),bottom:Math.max(...v.map(te=>te.bottom))},P=Pt.slice(0,5).map(te=>te.name).join(", "),Y=Pt.length>5?` +${Pt.length-5} more`:"",K=v.map(te=>({x:te.left,y:te.top+window.scrollY,width:te.width,height:te.height})),ce=Pt[Pt.length-1].element,de=v[v.length-1],Me=de.left+de.width/2,Oe=de.top+de.height/2,_e=Su(ce);me({x:Me/window.innerWidth*100,y:_e?Oe:Oe+window.scrollY,clientY:Oe,element:`${Pt.length} elements: ${P}${Y}`,elementPath:"multi-select",boundingBox:{x:k.left,y:k.top+window.scrollY,width:k.right-k.left,height:k.bottom-k.top},isMultiSelect:!0,isFixed:_e,elementBoundingBoxes:K,multiSelectElements:Pt.map(te=>te.element),targetElement:ce,fullPath:Ca(h),accessibility:ka(h),computedStyles:ba(h),computedStylesObj:wa(h),nearbyElements:va(h),cssClasses:Ii(h),nearbyText:Li(h),sourceFile:Na(h)})}else{let k=v[0],P=Su(h);me({x:k.left/window.innerWidth*100,y:P?k.top:k.top+window.scrollY,clientY:k.top,element:u.name,elementPath:u.path,boundingBox:{x:k.left,y:P?k.top:k.top+window.scrollY,width:k.width,height:k.height},isFixed:P,fullPath:Ca(h),accessibility:ka(h),computedStyles:ba(h),computedStylesObj:wa(h),nearbyElements:va(h),cssClasses:Ii(h),nearbyText:Li(h),reactComponents:u.reactComponents,sourceFile:Na(h)})}Dr([]),We(null)},[Pt]);(0,M.useEffect)(()=>{I||(me(null),U(null),xe(null),ve([]),We(null),J(!1),Dr([]),oo.current={cmd:!1,shift:!1},L&&Xi())},[I,L,Xi]),(0,M.useEffect)(()=>()=>{Qh()},[]),(0,M.useEffect)(()=>{if(!I)return;let u=["p","span","h1","h2","h3","h4","h5","h6","li","td","th","label","blockquote","figcaption","caption","legend","dt","dd","pre","code","em","strong","b","i","u","s","a","time","address","cite","q","abbr","dfn","mark","small","sub","sup","[contenteditable]"].join(", "),h=":not([data-agentation-root]):not([data-agentation-root] *)",x=document.createElement("style");return x.id="feedback-cursor-styles",x.textContent=`
      body ${h} {
        cursor: crosshair !important;
      }

      body :is(${u})${h} {
        cursor: text !important;
      }
    `,document.head.appendChild(x),()=>{let v=document.getElementById("feedback-cursor-styles");v&&v.remove()}},[I]),(0,M.useEffect)(()=>{if(ju!==null&&I)return document.documentElement.setAttribute("data-drawing-hover",""),()=>document.documentElement.removeAttribute("data-drawing-hover")},[ju,I]),(0,M.useEffect)(()=>{if(!I||X||jn||se)return;let u=h=>{let x=h.composedPath()[0]||h.target;if(sn(x,"[data-feedback-toolbar]")){We(null);return}let v=Lr(h.clientX,h.clientY);if(!v||sn(v,"[data-feedback-toolbar]")){We(null);return}let{name:k,elementName:P,path:Y,reactComponents:K}=ku(v,ir),re=v.getBoundingClientRect();We({element:k,elementName:P,elementPath:Y,rect:re,reactComponents:K}),Ke({x:h.clientX,y:h.clientY})};return document.addEventListener("mousemove",u),()=>document.removeEventListener("mousemove",u)},[I,X,jn,se,ir,Ln]);let Qi=(0,M.useCallback)(u=>{if(U(u),To(null),gn(null),dn([]),u.elementBoundingBoxes?.length){let h=[];for(let x of u.elementBoundingBoxes){let v=x.x+x.width/2,k=x.y+x.height/2-window.scrollY,P=Lr(v,k);P&&h.push(P)}ve(h),xe(null)}else if(u.boundingBox){let h=u.boundingBox,x=h.x+h.width/2,v=u.isFixed?h.y+h.height/2:h.y+h.height/2-window.scrollY,k=Lr(x,v);if(k){let P=k.getBoundingClientRect(),Y=P.width/h.width,K=P.height/h.height;Y<.5||K<.5?xe(null):xe(k)}else xe(null);ve([])}else xe(null),ve([])},[]);(0,M.useEffect)(()=>{if(!I||jn||se)return;let u=h=>{if(Hi.current){Hi.current=!1;return}let x=h.composedPath()[0]||h.target;if(sn(x,"[data-feedback-toolbar]")||sn(x,"[data-annotation-popup]")||sn(x,"[data-annotation-marker]"))return;if(h.metaKey&&h.shiftKey&&!X&&!Te){h.preventDefault(),h.stopPropagation();let st=Lr(h.clientX,h.clientY);if(!st)return;let Ot=st.getBoundingClientRect(),{name:ot,path:$t,reactComponents:be}=ku(st,ir),Ne=Pt.findIndex(vt=>vt.element===st);Ne>=0?Dr(vt=>vt.filter((Et,Un)=>Un!==Ne)):Dr(vt=>[...vt,{element:st,rect:Ot,name:ot,path:$t,reactComponents:be??void 0}]);return}let v=sn(x,"button, a, input, select, textarea, [role='button'], [onclick]");if(De.blockInteractions&&v&&(h.preventDefault(),h.stopPropagation()),X){if(v&&!De.blockInteractions)return;h.preventDefault(),o_.current?.shake();return}if(Te){if(v&&!De.blockInteractions)return;h.preventDefault(),r_.current?.shake();return}h.preventDefault();let k=Lr(h.clientX,h.clientY);if(!k)return;let{name:P,path:Y,reactComponents:K}=ku(k,ir),re=k.getBoundingClientRect(),ce=h.clientX/window.innerWidth*100,de=Su(k),Me=de?h.clientY:h.clientY+window.scrollY,Oe=window.getSelection(),_e;Oe&&Oe.toString().trim().length>0&&(_e=Oe.toString().trim().slice(0,500));let te=wa(k),Nt=ba(k);me({x:ce,y:Me,clientY:h.clientY,element:P,elementPath:Y,selectedText:_e,boundingBox:{x:re.left,y:de?re.top:re.top+window.scrollY,width:re.width,height:re.height},nearbyText:Li(k),cssClasses:Ii(k),isFixed:de,fullPath:Ca(k),accessibility:ka(k),computedStyles:Nt,computedStylesObj:te,nearbyElements:va(k),reactComponents:K??void 0,sourceFile:Na(k),targetElement:k}),We(null)};return document.addEventListener("click",u,!0),()=>document.removeEventListener("click",u,!0)},[I,jn,se,X,Te,De.blockInteractions,ir,Pt]),(0,M.useEffect)(()=>{if(!I)return;let u=v=>{v.key==="Meta"&&(oo.current.cmd=!0),v.key==="Shift"&&(oo.current.shift=!0)},h=v=>{let k=oo.current.cmd&&oo.current.shift;v.key==="Meta"&&(oo.current.cmd=!1),v.key==="Shift"&&(oo.current.shift=!1);let P=oo.current.cmd&&oo.current.shift;k&&!P&&Pt.length>0&&a_()},x=()=>{oo.current={cmd:!1,shift:!1},Dr([])};return document.addEventListener("keydown",u),document.addEventListener("keyup",h),window.addEventListener("blur",x),()=>{document.removeEventListener("keydown",u),document.removeEventListener("keyup",h),window.removeEventListener("blur",x)}},[I,Pt,a_]),(0,M.useEffect)(()=>{if(!I||X||jn||se)return;let u=h=>{let x=h.composedPath()[0]||h.target;sn(x,"[data-feedback-toolbar]")||sn(x,"[data-annotation-marker]")||sn(x,"[data-annotation-popup]")||new Set(["P","SPAN","H1","H2","H3","H4","H5","H6","LI","TD","TH","LABEL","BLOCKQUOTE","FIGCAPTION","CAPTION","LEGEND","DT","DD","PRE","CODE","EM","STRONG","B","I","U","S","A","TIME","ADDRESS","CITE","Q","ABBR","DFN","MARK","SMALL","SUB","SUP"]).has(x.tagName)||x.isContentEditable||(h.preventDefault(),Or.current={x:h.clientX,y:h.clientY})};return document.addEventListener("mousedown",u),()=>document.removeEventListener("mousedown",u)},[I,X,jn,se]),(0,M.useEffect)(()=>{if(!I||X)return;let u=h=>{if(!Or.current)return;let x=h.clientX-Or.current.x,v=h.clientY-Or.current.y,k=x*x+v*v,P=ja*ja;if(!xo&&k>=P&&(lo.current=Or.current,e_(!0),h.preventDefault()),(xo||k>=P)&&lo.current){if($l.current){let be=Math.min(lo.current.x,h.clientX),Ne=Math.min(lo.current.y,h.clientY),vt=Math.abs(h.clientX-lo.current.x),Et=Math.abs(h.clientY-lo.current.y);$l.current.style.transform=`translate(${be}px, ${Ne}px)`,$l.current.style.width=`${vt}px`,$l.current.style.height=`${Et}px`}let Y=Date.now();if(Y-t_.current<im)return;t_.current=Y;let K=lo.current.x,re=lo.current.y,ce=Math.min(K,h.clientX),de=Math.min(re,h.clientY),Me=Math.max(K,h.clientX),Oe=Math.max(re,h.clientY),_e=(ce+Me)/2,te=(de+Oe)/2,Nt=new Set,st=[[ce,de],[Me,de],[ce,Oe],[Me,Oe],[_e,te],[_e,de],[_e,Oe],[ce,te],[Me,te]];for(let[be,Ne]of st){let vt=document.elementsFromPoint(be,Ne);for(let Et of vt)Et instanceof HTMLElement&&Nt.add(Et)}let Ot=document.querySelectorAll("button, a, input, img, p, h1, h2, h3, h4, h5, h6, li, label, td, th, div, span, section, article, aside, nav");for(let be of Ot)if(be instanceof HTMLElement){let Ne=be.getBoundingClientRect(),vt=Ne.left+Ne.width/2,Et=Ne.top+Ne.height/2,Un=vt>=ce&&vt<=Me&&Et>=de&&Et<=Oe,In=Math.min(Ne.right,Me)-Math.max(Ne.left,ce),Ut=Math.min(Ne.bottom,Oe)-Math.max(Ne.top,de),Dl=In>0&&Ut>0?In*Ut:0,dr=Ne.width*Ne.height,Po=dr>0?Dl/dr:0;(Un||Po>.5)&&Nt.add(be)}let ot=[],$t=new Set(["BUTTON","A","INPUT","IMG","P","H1","H2","H3","H4","H5","H6","LI","LABEL","TD","TH","SECTION","ARTICLE","ASIDE","NAV"]);for(let be of Nt){if(sn(be,"[data-feedback-toolbar]")||sn(be,"[data-annotation-marker]"))continue;let Ne=be.getBoundingClientRect();if(!(Ne.width>window.innerWidth*.8&&Ne.height>window.innerHeight*.5)&&!(Ne.width<10||Ne.height<10)&&Ne.left<Me&&Ne.right>ce&&Ne.top<Oe&&Ne.bottom>de){let vt=be.tagName,Et=$t.has(vt);if(!Et&&(vt==="DIV"||vt==="SPAN")){let Un=be.textContent&&be.textContent.trim().length>0,In=be.onclick!==null||be.getAttribute("role")==="button"||be.getAttribute("role")==="link"||be.classList.contains("clickable")||be.hasAttribute("data-clickable");(Un||In)&&!be.querySelector("p, h1, h2, h3, h4, h5, h6, button, a")&&(Et=!0)}if(Et){let Un=!1;for(let In of ot)if(In.left<=Ne.left&&In.right>=Ne.right&&In.top<=Ne.top&&In.bottom>=Ne.bottom){Un=!0;break}Un||ot.push(Ne)}}}if(Rl.current){let be=Rl.current;for(;be.children.length>ot.length;)be.removeChild(be.lastChild);ot.forEach((Ne,vt)=>{let Et=be.children[vt];Et||(Et=document.createElement("div"),Et.className=A.selectedElementHighlight,be.appendChild(Et)),Et.style.transform=`translate(${Ne.left}px, ${Ne.top}px)`,Et.style.width=`${Ne.width}px`,Et.style.height=`${Ne.height}px`})}}};return document.addEventListener("mousemove",u,{passive:!0}),()=>document.removeEventListener("mousemove",u)},[I,X,xo,ja]),(0,M.useEffect)(()=>{if(!I)return;let u=h=>{let x=xo,v=lo.current;if(xo&&v){Hi.current=!0;let k=Math.min(v.x,h.clientX),P=Math.min(v.y,h.clientY),Y=Math.max(v.x,h.clientX),K=Math.max(v.y,h.clientY),re=[];document.querySelectorAll("button, a, input, img, p, h1, h2, h3, h4, h5, h6, li, label, td, th").forEach(_e=>{if(!(_e instanceof HTMLElement)||sn(_e,"[data-feedback-toolbar]")||sn(_e,"[data-annotation-marker]"))return;let te=_e.getBoundingClientRect();te.width>window.innerWidth*.8&&te.height>window.innerHeight*.5||te.width<10||te.height<10||te.left<Y&&te.right>k&&te.top<K&&te.bottom>P&&re.push({element:_e,rect:te})});let de=re.filter(({element:_e})=>!re.some(({element:te})=>te!==_e&&_e.contains(te))),Me=h.clientX/window.innerWidth*100,Oe=h.clientY+window.scrollY;if(de.length>0){let _e=de.reduce(($t,{rect:be})=>({left:Math.min($t.left,be.left),top:Math.min($t.top,be.top),right:Math.max($t.right,be.right),bottom:Math.max($t.bottom,be.bottom)}),{left:1/0,top:1/0,right:-1/0,bottom:-1/0}),te=de.slice(0,5).map(({element:$t})=>wl($t).name).join(", "),Nt=de.length>5?` +${de.length-5} more`:"",st=de[0].element,Ot=wa(st),ot=ba(st);me({x:Me,y:Oe,clientY:h.clientY,element:`${de.length} elements: ${te}${Nt}`,elementPath:"multi-select",boundingBox:{x:_e.left,y:_e.top+window.scrollY,width:_e.right-_e.left,height:_e.bottom-_e.top},isMultiSelect:!0,fullPath:Ca(st),accessibility:ka(st),computedStyles:ot,computedStylesObj:Ot,nearbyElements:va(st),cssClasses:Ii(st),nearbyText:Li(st),sourceFile:Na(st)})}else{let _e=Math.abs(Y-k),te=Math.abs(K-P);_e>20&&te>20&&me({x:Me,y:Oe,clientY:h.clientY,element:"Area selection",elementPath:`region at (${Math.round(k)}, ${Math.round(P)})`,boundingBox:{x:k,y:P+window.scrollY,width:_e,height:te},isMultiSelect:!0})}We(null)}else x&&(Hi.current=!0);Or.current=null,lo.current=null,e_(!1),Rl.current&&(Rl.current.innerHTML="")};return document.addEventListener("mouseup",u),()=>document.removeEventListener("mouseup",u)},[I,xo]);let io=(0,M.useCallback)(async(u,h,x)=>{let v=De.webhookUrl||$;if(!v||!De.webhooksEnabled&&!x)return!1;try{return(await fetch(v,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({event:u,timestamp:Date.now(),url:typeof window<"u"?window.location.href:void 0,...h})})).ok}catch(k){return console.warn("[Agentation] Webhook failed:",k),!1}},[$,De.webhookUrl,De.webhooksEnabled]),am=(0,M.useCallback)(u=>{if(!X)return;let h={id:Date.now().toString(),x:X.x,y:X.y,comment:u,element:X.element,elementPath:X.elementPath,timestamp:Date.now(),selectedText:X.selectedText,boundingBox:X.boundingBox,nearbyText:X.nearbyText,cssClasses:X.cssClasses,isMultiSelect:X.isMultiSelect,isFixed:X.isFixed,fullPath:X.fullPath,accessibility:X.accessibility,computedStyles:X.computedStyles,nearbyElements:X.nearbyElements,reactComponents:X.reactComponents,sourceFile:X.sourceFile,elementBoundingBoxes:X.elementBoundingBoxes,...p&&zt?{sessionId:zt,url:typeof window<"u"?window.location.href:void 0,status:"pending"}:{}};g(x=>[...x,h]),Ui.current=h.id,fe(()=>{Ui.current=null},300),fe(()=>{Il(x=>new Set(x).add(h.id))},250),o?.(h),io("annotation.add",{annotation:h}),ji(!0),fe(()=>{me(null),ji(!1)},150),window.getSelection()?.removeAllRanges(),p&&zt&&yl(p,zt,h).then(x=>{x.id!==h.id&&(g(v=>v.map(k=>k.id===h.id?{...k,id:x.id}:k)),Il(v=>{let k=new Set(v);return k.delete(h.id),k.add(x.id),k}))}).catch(x=>{console.warn("[Agentation] Failed to sync annotation:",x)})},[X,o,io,p,zt]),Xa=(0,M.useCallback)(()=>{ji(!0),fe(()=>{me(null),ji(!1)},150)},[]),Qa=(0,M.useCallback)(u=>{let h=f.findIndex(v=>v.id===u),x=f[h];Te?.id===u&&(zr(!0),fe(()=>{U(null),xe(null),ve([]),zr(!1)},150)),to(u),Fi(v=>new Set(v).add(u)),x&&(r?.(x),io("annotation.delete",{annotation:x})),p&&or(p,u).catch(v=>{console.warn("[Agentation] Failed to delete annotation from server:",v)}),fe(()=>{g(v=>v.filter(k=>k.id!==u)),Fi(v=>{let k=new Set(v);return k.delete(u),k}),to(null),h<f.length-1&&(Wn(h),fe(()=>Wn(null),200))},150)},[f,Te,r,io,p]),Vi=(0,M.useCallback)(u=>{if(!u){To(null),gn(null),dn([]);return}if(To(u.id),u.elementBoundingBoxes?.length){let h=[];for(let x of u.elementBoundingBoxes){let v=x.x+x.width/2,k=x.y+x.height/2-window.scrollY,Y=document.elementsFromPoint(v,k).find(K=>!K.closest("[data-annotation-marker]")&&!K.closest("[data-agentation-root]"));Y&&h.push(Y)}dn(h),gn(null)}else if(u.boundingBox){let h=u.boundingBox,x=h.x+h.width/2,v=u.isFixed?h.y+h.height/2:h.y+h.height/2-window.scrollY,k=Lr(x,v);if(k){let P=k.getBoundingClientRect(),Y=P.width/h.width,K=P.height/h.height;Y<.5||K<.5?gn(null):gn(k)}else gn(null);dn([])}else gn(null),dn([])},[]),cm=(0,M.useCallback)(u=>{if(!Te)return;let h={...Te,comment:u};g(x=>x.map(v=>v.id===Te.id?h:v)),l?.(h),io("annotation.update",{annotation:h}),p&&cp(p,Te.id,{comment:u}).catch(x=>{console.warn("[Agentation] Failed to update annotation on server:",x)}),zr(!0),fe(()=>{U(null),xe(null),ve([]),zr(!1)},150)},[Te,l,io,p]),dm=(0,M.useCallback)(()=>{zr(!0),fe(()=>{U(null),xe(null),ve([]),zr(!1)},150)},[]),cr=(0,M.useCallback)(()=>{let u=f.length,h=ae.length>0||!!Ce;if(u===0&&Ln.length===0&&!h)return;if(i?.(f),io("annotations.clear",{annotations:f}),p){Promise.all(f.map(k=>or(p,k.id).catch(P=>{console.warn("[Agentation] Failed to delete annotation from server:",P)})));for(let[,k]of Ml.current)k&&or(p,k).catch(()=>{});Ml.current.clear();for(let[,k]of El.current)k&&or(p,k).catch(()=>{});El.current.clear()}On(!0),Sn(!0),Zp([]);let x=Oa.current;if(x){let k=x.getContext("2d");k&&k.clearRect(0,0,x.width,x.height)}(ae.length>0||Ce)&&(Ba(k=>k+1),Wu(k=>k+1),fe(()=>{nt([]),En(null)},200)),we&&ut(!1),It&&yo(""),lr.current={rearrange:null,placements:[]},Ea(ge);let v=u*30+200;fe(()=>{g([]),Il(new Set),localStorage.removeItem(Ta(ge)),On(!1)},v),fe(()=>Sn(!1),1500)},[ge,f,Ln,ae,Ce,we,It,i,io,p]),Va=(0,M.useCallback)(async()=>{let u=typeof window<"u"?window.location.pathname+window.location.search+window.location.hash:ge,h=se&&we,x;if(h){if(ae.length===0&&!Ce&&!It)return;x=""}else{if(x=_p(f,u,De.outputDetail),!x&&Ln.length===0&&ae.length===0&&!Ce)return;x||(x=`## Page Feedback: ${u}
`)}if(!h&&Ln.length>0){let v=new Set;for(let K of f)K.drawingIndex!=null&&v.add(K.drawingIndex);let k=Oa.current;k&&(k.style.visibility="hidden");let P=[],Y=window.scrollY;for(let K=0;K<Ln.length;K++){if(v.has(K))continue;let re=Ln[K];if(re.points.length<2)continue;let ce=re.fixed?re.points:re.points.map(Dt=>({x:Dt.x,y:Dt.y-Y})),de=1/0,Me=1/0,Oe=-1/0,_e=-1/0;for(let Dt of ce)de=Math.min(de,Dt.x),Me=Math.min(Me,Dt.y),Oe=Math.max(Oe,Dt.x),_e=Math.max(_e,Dt.y);let te=Oe-de,Nt=_e-Me,st=Math.hypot(te,Nt),Ot=ce[0],ot=ce[ce.length-1],$t=Math.hypot(ot.x-Ot.x,ot.y-Ot.y),be,Ne=$t<st*.35,vt=te/Math.max(Nt,1);if(Ne&&st>20){let Dt=Math.max(te,Nt)*.15,Do=0;for(let ur of ce){let fm=ur.x-de<Dt,hm=Oe-ur.x<Dt,pm=ur.y-Me<Dt,mm=_e-ur.y<Dt;(fm||hm)&&(pm||mm)&&Do++}be=Do>ce.length*.15?"box":"circle"}else vt>3&&Nt<40?be="underline":$t>st*.5?be="arrow":be="drawing";let Et=Math.min(10,ce.length),Un=Math.max(1,Math.floor(ce.length/Et)),In=new Set,Ut=[],Dl=[Ot];for(let Dt=Un;Dt<ce.length-1;Dt+=Un)Dl.push(ce[Dt]);Dl.push(ot);for(let Dt of Dl){let Do=Lr(Dt.x,Dt.y);if(!Do||In.has(Do)||sn(Do,"[data-feedback-toolbar]"))continue;In.add(Do);let{name:ur}=wl(Do);Ut.includes(ur)||Ut.push(ur)}let dr=`${Math.round(de)},${Math.round(Me)} \u2192 ${Math.round(Oe)},${Math.round(_e)}`,Po;(be==="circle"||be==="box")&&Ut.length>0?Po=`${be==="box"?"Boxed":"Circled"} **${Ut[0]}**${Ut.length>1?` (and ${Ut.slice(1).join(", ")})`:""} (region: ${dr})`:be==="underline"&&Ut.length>0?Po=`Underlined **${Ut[0]}** (${dr})`:be==="arrow"&&Ut.length>=2?Po=`Arrow from **${Ut[0]}** to **${Ut[Ut.length-1]}** (${Math.round(Ot.x)},${Math.round(Ot.y)} \u2192 ${Math.round(ot.x)},${Math.round(ot.y)})`:Ut.length>0?Po=`${be==="arrow"?"Arrow":"Drawing"} near **${Ut.join("**, **")}** (region: ${dr})`:Po=`Drawing at ${dr}`,P.push(Po)}k&&(k.style.visibility=""),P.length>0&&(x+=`
**Drawings:**
`,P.forEach((K,re)=>{x+=`${re+1}. ${K}
`}))}if((ae.length>0||h&&It)&&(x+=`
`+lp(ae,{width:window.innerWidth,height:window.innerHeight},{blankCanvas:we,wireframePurpose:It||void 0},De.outputDetail)),Ce){let v=ip(Ce,De.outputDetail,{width:window.innerWidth,height:window.innerHeight});v&&(x+=`
`+v)}if(m)try{await navigator.clipboard.writeText(x)}catch{}s?.(x),Mt(!0),fe(()=>Mt(!1),2e3),De.autoClearAfterCopy&&fe(()=>cr(),500)},[f,Ln,ae,Ce,we,se,go,It,ge,De.outputDetail,ir,De.autoClearAfterCopy,cr,m,s]),Ka=(0,M.useCallback)(async()=>{let u=typeof window<"u"?window.location.pathname+window.location.search+window.location.hash:ge,h=_p(f,u,De.outputDetail);if(!h&&ae.length===0&&!Ce)return;if(h||(h=`## Page Feedback: ${u}
`),ae.length>0&&(h+=`
`+lp(ae,{width:window.innerWidth,height:window.innerHeight},{blankCanvas:we,wireframePurpose:It||void 0},De.outputDetail)),Ce){let v=ip(Ce,De.outputDetail,{width:window.innerWidth,height:window.innerHeight});v&&(h+=`
`+v)}a&&a(h,f),en("sending"),await new Promise(v=>fe(v,150));let x=await io("submit",{output:h,annotations:f},!0);en(x?"sent":"failed"),fe(()=>en("idle"),2500),x&&De.autoClearAfterCopy&&fe(()=>cr(),500)},[a,io,f,ae,Ce,we,go,ge,De.outputDetail,ir,De.autoClearAfterCopy,cr]);(0,M.useEffect)(()=>{if(!Br)return;let u=10,h=v=>{let k=v.clientX-Br.x,P=v.clientY-Br.y,Y=Math.sqrt(k*k+P*P);if(!ar&&Y>u&&Gu(!0),ar||Y>u){let K=Br.toolbarX+k,re=Br.toolbarY+P,ce=20,de=337,Me=44,_e=de-(I?Hn==="connected"?297:257:44),te=ce-_e,Nt=window.innerWidth-ce-de;K=Math.max(te,Math.min(Nt,K)),re=Math.max(ce,Math.min(window.innerHeight-Me-ce,re)),Wa({x:K,y:re})}},x=()=>{ar&&(Fa.current=!0),Gu(!1),qu(null)};return document.addEventListener("mousemove",h),document.addEventListener("mouseup",x),()=>{document.removeEventListener("mousemove",h),document.removeEventListener("mouseup",x)}},[Br,ar,I,Hn]);let um=(0,M.useCallback)(u=>{if(u.target.closest("button")||u.target.closest("[data-agentation-settings-panel]"))return;let h=u.currentTarget.parentElement;if(!h)return;let x=h.getBoundingClientRect(),v=xt?.x??x.left,k=xt?.y??x.top;qu({x:u.clientX,y:u.clientY,toolbarX:v,toolbarY:k})},[xt]);if((0,M.useEffect)(()=>{if(!xt)return;let u=()=>{let k=xt.x,P=xt.y,re=20-(337-(I?Hn==="connected"?297:257:44)),ce=window.innerWidth-20-337;k=Math.max(re,Math.min(ce,k)),P=Math.max(20,Math.min(window.innerHeight-44-20,P)),(k!==xt.x||P!==xt.y)&&Wa({x:k,y:P})};return u(),window.addEventListener("resize",u),()=>window.removeEventListener("resize",u)},[xt,I,Hn]),(0,M.useEffect)(()=>{let u=h=>{let x=h.target,v=x.tagName==="INPUT"||x.tagName==="TEXTAREA"||x.isContentEditable;if(h.key==="Escape"){if(se){je?Ie(null):Yi();return}if(jn){za(!1);return}if(Pt.length>0){Dr([]);return}X||I&&(Vt(),E(!1))}if((h.metaKey||h.ctrlKey)&&h.shiftKey&&(h.key==="f"||h.key==="F")){h.preventDefault(),Vt(),I?i_():E(!0);return}if(!(v||h.metaKey||h.ctrlKey)&&((h.key==="p"||h.key==="P")&&(h.preventDefault(),Vt(),Ya()),(h.key==="l"||h.key==="L")&&(h.preventDefault(),Vt(),jn&&za(!1),O&&J(!1),X&&Xa(),se?Yi():tt(!0)),(h.key==="h"||h.key==="H")&&f.length>0&&(h.preventDefault(),Vt(),N(k=>!k)),(h.key==="c"||h.key==="C")&&(f.length>0||ae.length>0||Ce)&&(h.preventDefault(),Vt(),Va()),(h.key==="x"||h.key==="X")&&(f.length>0||ae.length>0||Ce)&&(h.preventDefault(),Vt(),cr(),ae.length>0&&nt([]),Ce&&En(null)),h.key==="s"||h.key==="S")){let k=ho(De.webhookUrl)||ho($||"");f.length>0&&k&&cn==="idle"&&(h.preventDefault(),Vt(),Ka())}};return document.addEventListener("keydown",u),()=>document.removeEventListener("keydown",u)},[I,jn,se,je,ae,Ce,X,f.length,De.webhookUrl,$,cn,Ka,Ya,Va,cr,Pt]),!pe||H)return null;let Pl=f.length>0,Wr=f.filter(u=>!Ju.has(u.id)&&u.kind!=="placement"&&u.kind!=="rearrange"),_m=Wr.length>0,c_=f.filter(u=>Ju.has(u.id)),d_=u=>{let P=u.x/100*window.innerWidth,Y=typeof u.y=="string"?parseFloat(u.y):u.y,K={};window.innerHeight-Y-22-10<80&&(K.top="auto",K.bottom="calc(100% + 10px)");let ce=P-200/2,de=10;if(ce<de){let Me=de-ce;K.left=`calc(50% + ${Me}px)`}else if(ce+200>window.innerWidth-de){let Me=ce+200-(window.innerWidth-de);K.left=`calc(50% - ${Me}px)`}return K};return(0,yp.createPortal)((0,W.jsxs)("div",{ref:ye,style:{display:"contents"},"data-agentation-theme":ro?"dark":"light","data-agentation-accent":De.annotationColorId,"data-agentation-root":"",children:[(0,W.jsx)("div",{className:`${A.toolbar}${C?` ${C}`:""}`,"data-feedback-toolbar":!0,"data-agentation-toolbar":!0,style:xt?{left:xt.x,top:xt.y,right:"auto",bottom:"auto"}:void 0,children:(0,W.jsxs)("div",{className:`${A.toolbarContainer} ${I?A.expanded:A.collapsed} ${Xu?A.entrance:""} ${D?A.hiding:""} ${!De.webhooksEnabled&&(ho(De.webhookUrl)||ho($||""))?A.serverConnected:""}`,onClick:I?void 0:u=>{if(Fa.current){Fa.current=!1,u.preventDefault();return}E(!0)},onMouseDown:um,role:I?void 0:"button",tabIndex:I?-1:0,title:I?void 0:"Start feedback mode",children:[(0,W.jsxs)("div",{className:`${A.toggleContent} ${I?A.hidden:A.visible}`,children:[(0,W.jsx)(qg,{size:24}),_m&&(0,W.jsx)("span",{className:`${A.badge} ${I?A.fadeOut:""} ${Xu?A.entrance:""}`,children:Wr.length})]}),(0,W.jsxs)("div",{className:`${A.controlsContent} ${I?A.visible:A.hidden} ${xt&&xt.y<100?A.tooltipBelow:""} ${Fe||O?A.tooltipsHidden:""} ${Hu?A.tooltipsInSession:""}`,onMouseEnter:tm,onMouseLeave:nm,children:[(0,W.jsxs)("div",{className:`${A.buttonWrapper} ${xt&&xt.x<120?A.buttonWrapperAlignLeft:""}`,children:[(0,W.jsx)("button",{className:A.controlButton,onClick:u=>{u.stopPropagation(),Vt(),Ya()},"data-active":L,children:(0,W.jsx)(ny,{size:24,isPaused:L})}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:[L?"Resume animations":"Pause animations",(0,W.jsx)("span",{className:A.shortcut,children:"P"})]})]}),(0,W.jsxs)("div",{className:A.buttonWrapper,children:[(0,W.jsx)("button",{className:`${A.controlButton} ${ro?"":A.light}`,onClick:u=>{u.stopPropagation(),Vt(),jn&&za(!1),O&&J(!1),X&&Xa(),se?Yi():tt(!0)},"data-active":se,style:se&&we?{color:"#f97316",background:"rgba(249, 115, 22, 0.25)"}:void 0,children:(0,W.jsx)(uy,{size:21})}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:[se?"Exit layout mode":"Layout mode",(0,W.jsx)("span",{className:A.shortcut,children:"L"})]})]}),(0,W.jsxs)("div",{className:A.buttonWrapper,children:[(0,W.jsx)("button",{className:A.controlButton,onClick:u=>{u.stopPropagation(),Vt(),N(!w)},disabled:!Pl||se,children:(0,W.jsx)(ty,{size:24,isOpen:w})}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:[w?"Hide markers":"Show markers",(0,W.jsx)("span",{className:A.shortcut,children:"H"})]})]}),(0,W.jsxs)("div",{className:A.buttonWrapper,children:[(0,W.jsx)("button",{className:`${A.controlButton} ${Ue?A.statusShowing:""}`,onClick:u=>{u.stopPropagation(),Vt(),Va()},disabled:se&&we?ae.length===0&&!Ce?.sections?.length:!Pl&&Ln.length===0&&ae.length===0&&!Ce?.sections?.length,"data-active":Ue,children:(0,W.jsx)(Jg,{size:24,copied:Ue,tint:se&&we&&(ae.length>0||Ce?.sections?.length)?"#f97316":void 0})}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:[se&&we?"Copy layout":"Copy feedback",(0,W.jsx)("span",{className:A.shortcut,children:"C"})]})]}),(0,W.jsxs)("div",{className:`${A.buttonWrapper} ${A.sendButtonWrapper} ${I&&!De.webhooksEnabled&&(ho(De.webhookUrl)||ho($||""))?A.sendButtonVisible:""}`,children:[(0,W.jsxs)("button",{className:`${A.controlButton} ${cn==="sent"||cn==="failed"?A.statusShowing:""}`,onClick:u=>{u.stopPropagation(),Vt(),Ka()},disabled:!Pl||!ho(De.webhookUrl)&&!ho($||"")||cn==="sending","data-no-hover":cn==="sent"||cn==="failed",tabIndex:ho(De.webhookUrl)||ho($||"")?0:-1,children:[(0,W.jsx)(ey,{size:24,state:cn}),Pl&&cn==="idle"&&(0,W.jsx)("span",{className:A.buttonBadge,children:f.length})]}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:["Send Annotations",(0,W.jsx)("span",{className:A.shortcut,children:"S"})]})]}),(0,W.jsxs)("div",{className:A.buttonWrapper,children:[(0,W.jsx)("button",{className:A.controlButton,onClick:u=>{u.stopPropagation(),Vt(),cr()},disabled:!Pl&&Ln.length===0&&ae.length===0&&!Ce?.sections?.length,"data-danger":!0,children:(0,W.jsx)(ry,{size:24})}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:["Clear all",(0,W.jsx)("span",{className:A.shortcut,children:"X"})]})]}),(0,W.jsxs)("div",{className:A.buttonWrapper,children:[(0,W.jsx)("button",{className:A.controlButton,onClick:u=>{u.stopPropagation(),Vt(),se&&Yi(),J(!O)},children:(0,W.jsx)(oy,{size:24})}),p&&Hn!=="disconnected"&&(0,W.jsx)("span",{className:`${A.mcpIndicator} ${A[Hn]} ${O?A.hidden:""}`,title:Hn==="connected"?"MCP Connected":"MCP Connecting..."}),(0,W.jsx)("span",{className:A.buttonTooltip,children:"Settings"})]}),(0,W.jsx)("div",{className:A.divider}),(0,W.jsxs)("div",{className:`${A.buttonWrapper} ${xt&&typeof window<"u"&&xt.x>window.innerWidth-120?A.buttonWrapperAlignRight:""}`,children:[(0,W.jsx)("button",{className:A.controlButton,onClick:u=>{u.stopPropagation(),Vt(),i_()},children:(0,W.jsx)(ly,{size:24})}),(0,W.jsxs)("span",{className:A.buttonTooltip,children:["Exit",(0,W.jsx)("span",{className:A.shortcut,children:"Esc"})]})]})]}),(0,W.jsx)(W5,{visible:se&&I,activeType:je,onSelect:u=>{Ie(je===u?null:u)},isDarkMode:ro,sectionCount:Ce?.sections.length??0,onDetectSections:()=>{let u=q5(),h=Ce?.sections??[],x=new Set(h.map(Y=>Y.selector)),v=u.filter(Y=>!x.has(Y.selector)),k=[...h,...v],P=[...Ce?.originalOrder??[],...v.map(Y=>Y.id)];En({sections:k,originalOrder:P,detectedAt:Date.now()})},placementCount:ae.length,onClearPlacements:()=>{Ba(u=>u+1),Wu(u=>u+1),fe(()=>{En({sections:[],originalOrder:[],detectedAt:Date.now()})},200)},blankCanvas:we,onBlankCanvasChange:u=>{let h={sections:[],originalOrder:[],detectedAt:Date.now()};u?(Da.current={rearrange:Ce,placements:ae},En(lr.current.rearrange||h),nt(lr.current.placements),Ie(null)):(lr.current={rearrange:Ce,placements:ae},En(Da.current.rearrange||h),nt(Da.current.placements)),ut(u)},wireframePurpose:It,onWireframePurposeChange:yo,Tooltip:Nr,onDragStart:(u,h)=>{h.preventDefault();let x=ee[u],v=null,k=!1,P=h.clientX,Y=h.clientY,re=h.target.closest("[data-feedback-toolbar]")?.getBoundingClientRect().top??window.innerHeight,ce=Me=>{let Oe=Me.clientX-P,_e=Me.clientY-Y;if(!k&&(Math.abs(Oe)>4||Math.abs(_e)>4)&&(k=!0,v=document.createElement("div"),v.className=`${T.dragPreview}${we?` ${T.dragPreviewWireframe}`:""}`,document.body.appendChild(v)),!v)return;let te=Math.max(0,re-Me.clientY),Nt=Math.min(1,te/180),st=1-Math.pow(1-Nt,2),Ot=28,ot=20,$t=Math.min(140,x.width*.18),be=Math.min(90,x.height*.18),Ne=Ot+($t-Ot)*st,vt=ot+(be-ot)*st;v.style.width=`${Ne}px`,v.style.height=`${vt}px`,v.style.left=`${Me.clientX-Ne/2}px`,v.style.top=`${Me.clientY-vt/2}px`,v.style.opacity=`${.5+.5*st}`,v.textContent=st>.25?u:""},de=Me=>{if(window.removeEventListener("mousemove",ce),window.removeEventListener("mouseup",de),v&&document.body.removeChild(v),k){let Oe=x.width,_e=x.height,te=window.scrollY,Nt=Math.max(0,Me.clientX-Oe/2),st=Math.max(0,Me.clientY+te-_e/2),Ot={id:`dp-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,type:u,x:Nt,y:st,width:Oe,height:_e,scrollY:te,timestamp:Date.now()};nt(ot=>[...ot,Ot]),Ie(null),Sl.current=new Set,Au(ot=>ot+1)}};window.addEventListener("mousemove",ce),window.addEventListener("mouseup",de)}}),(0,W.jsx)(ix,{settings:De,onSettingsChange:u=>om(h=>({...h,...u})),isDarkMode:ro,onToggleTheme:rm,isDevMode:Vu,connectionStatus:Hn,endpoint:p,isVisible:le,toolbarNearBottom:!!xt&&xt.y<230,settingsPage:ie,onSettingsPageChange:Se,onHideToolbar:sm})]})}),(se||Pe)&&(0,W.jsx)("div",{className:`${T.blankCanvas} ${Ft?T.visible:""} ${Oi?T.gridActive:""}`,style:{"--canvas-opacity":no},"data-feedback-toolbar":!0}),se&&we&&Ft&&(0,W.jsxs)("div",{className:T.wireframeNotice,"data-feedback-toolbar":!0,children:[(0,W.jsxs)("div",{className:T.wireframeOpacityRow,children:[(0,W.jsx)("span",{className:T.wireframeOpacityLabel,children:"Toggle Opacity"}),(0,W.jsx)("input",{type:"range",className:T.wireframeOpacitySlider,min:0,max:1,step:.01,value:no,onChange:u=>un(Number(u.target.value))})]}),(0,W.jsxs)("div",{className:T.wireframeNoticeTitleRow,children:[(0,W.jsx)("span",{className:T.wireframeNoticeTitle,children:"Wireframe Mode"}),(0,W.jsx)("span",{className:T.wireframeNoticeDivider}),(0,W.jsx)("button",{className:T.wireframeStartOver,onClick:()=>{Ba(u=>u+1),En({sections:[],originalOrder:[],detectedAt:Date.now()}),lr.current={rearrange:null,placements:[]},yo(""),Ea(ge)},children:"Start Over"})]}),"Drag components onto the canvas.",(0,W.jsx)("br",{}),"Copied output will only include the wireframed layout."]}),(se||Pe)&&(0,W.jsx)(D5,{placements:ae,onChange:nt,activeComponent:Pe?null:je,onActiveComponentChange:Ie,isDarkMode:ro,exiting:Pe,onInteractionChange:Xp,passthrough:!je,extraSnapRects:Ce?.sections.map(u=>u.currentRect),deselectSignal:Qp,clearSignal:Gp,wireframe:we,onSelectionChange:(u,h)=>{Sl.current=u,h||(Ai.current=new Set,Kp(x=>x+1))},onDragMove:(u,h)=>{let x=Ai.current;if(!(!x.size||!Ce)){if(!Fn.current){Fn.current=new Map;for(let v of Ce.sections)x.has(v.id)&&Fn.current.set(v.id,{x:v.currentRect.x,y:v.currentRect.y})}for(let v of Ce.sections){if(!x.has(v.id)||!Fn.current.get(v.id))continue;let P=document.querySelector(`[data-rearrange-section="${v.id}"]`);P&&(P.style.transform=`translate(${u}px, ${h}px)`)}}},onDragEnd:(u,h,x)=>{let v=Ai.current,k=Fn.current;if(Fn.current=null,!(!v.size||!Ce||!k)){for(let P of v){let Y=document.querySelector(`[data-rearrange-section="${P}"]`);Y&&(Y.style.transform="")}x&&En(P=>P&&{...P,sections:P.sections.map(Y=>{let K=k.get(Y.id);return K?{...Y,currentRect:{...Y.currentRect,x:Math.max(0,K.x+u),y:Math.max(0,K.y+h)}}:Y})})}}}),(se||Pe)&&Ce&&(0,W.jsx)(e2,{rearrangeState:Ce,onChange:En,isDarkMode:ro,exiting:Pe,blankCanvas:we,extraSnapRects:ae.map(u=>({x:u.x,y:u.y,width:u.width,height:u.height})),clearSignal:qp,deselectSignal:Vp,onSelectionChange:(u,h)=>{Ai.current=u,h||(Sl.current=new Set,Au(x=>x+1))},onDragMove:(u,h)=>{let x=Sl.current;if(x.size){if(!Fn.current){Fn.current=new Map;for(let v of ae)x.has(v.id)&&Fn.current.set(v.id,{x:v.x,y:v.y})}for(let v of x){let k=document.querySelector(`[data-design-placement="${v}"]`);k&&(k.style.transform=`translate(${u}px, ${h}px)`)}}},onDragEnd:(u,h,x)=>{let v=Sl.current,k=Fn.current;if(Fn.current=null,!(!v.size||!k)){for(let P of v){let Y=document.querySelector(`[data-design-placement="${P}"]`);Y&&(Y.style.transform="")}x&&nt(P=>P.map(Y=>{let K=k.get(Y.id);return K?{...Y,x:Math.max(0,K.x+u),y:Math.max(0,K.y+h)}:Y}))}}}),(0,W.jsx)("canvas",{ref:Oa,className:`${A.drawCanvas} ${jn?A.active:""}`,style:{opacity:Ha?1:0,transition:"opacity 0.15s ease"},"data-feedback-toolbar":!0}),(0,W.jsxs)("div",{className:A.markersLayer,"data-feedback-toolbar":!0,children:[Z&&Wr.filter(u=>!u.isFixed).map((u,h,x)=>(0,W.jsx)(fp,{annotation:u,globalIndex:Wr.findIndex(v=>v.id===u.id),layerIndex:h,layerSize:x.length,isExiting:Ge,isClearing:Ro,isAnimated:Zu.has(u.id),isHovered:!Ge&&mo===u.id,isDeleting:eo===u.id,isEditingAny:!!Te,renumberFrom:Tr,markerClickBehavior:De.markerClickBehavior,tooltipStyle:d_(u),onHoverEnter:v=>!Ge&&v.id!==Ui.current&&Vi(v),onHoverLeave:()=>Vi(null),onClick:v=>De.markerClickBehavior==="delete"?Qa(v.id):Qi(v),onContextMenu:Qi},u.id)),Z&&!Ge&&c_.filter(u=>!u.isFixed).map(u=>(0,W.jsx)(hp,{annotation:u},u.id))]}),(0,W.jsxs)("div",{className:A.fixedMarkersLayer,"data-feedback-toolbar":!0,children:[Z&&Wr.filter(u=>u.isFixed).map((u,h,x)=>(0,W.jsx)(fp,{annotation:u,globalIndex:Wr.findIndex(v=>v.id===u.id),layerIndex:h,layerSize:x.length,isExiting:Ge,isClearing:Ro,isAnimated:Zu.has(u.id),isHovered:!Ge&&mo===u.id,isDeleting:eo===u.id,isEditingAny:!!Te,renumberFrom:Tr,markerClickBehavior:De.markerClickBehavior,tooltipStyle:d_(u),onHoverEnter:v=>!Ge&&v.id!==Ui.current&&Vi(v),onHoverLeave:()=>Vi(null),onClick:v=>De.markerClickBehavior==="delete"?Qa(v.id):Qi(v),onContextMenu:Qi},u.id)),Z&&!Ge&&c_.filter(u=>u.isFixed).map(u=>(0,W.jsx)(hp,{annotation:u,fixed:!0},u.id))]}),I&&(0,W.jsxs)("div",{className:A.overlay,"data-feedback-toolbar":!0,style:X||Te?{zIndex:99999}:void 0,children:[Re?.rect&&!X&&!Ye&&!xo&&(0,W.jsx)("div",{className:`${A.hoverHighlight} ${A.enter}`,style:{left:Re.rect.left,top:Re.rect.top,width:Re.rect.width,height:Re.rect.height,borderColor:"color-mix(in srgb, var(--agentation-color-accent) 50%, transparent)",backgroundColor:"color-mix(in srgb, var(--agentation-color-accent) 4%, transparent)"}}),Pt.filter(u=>document.contains(u.element)).map((u,h)=>{let x=u.element.getBoundingClientRect(),v=Pt.length>1;return(0,W.jsx)("div",{className:v?A.multiSelectOutline:A.singleSelectOutline,style:{position:"fixed",left:x.left,top:x.top,width:x.width,height:x.height,...v?{}:{borderColor:"color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",backgroundColor:"color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"}}},h)}),mo&&!X&&(()=>{let u=f.find(k=>k.id===mo);if(!u?.boundingBox)return null;if(u.elementBoundingBoxes?.length)return An.length>0?An.filter(k=>document.contains(k)).map((k,P)=>{let Y=k.getBoundingClientRect();return(0,W.jsx)("div",{className:`${A.multiSelectOutline} ${A.enter}`,style:{left:Y.left,top:Y.top,width:Y.width,height:Y.height}},`hover-outline-live-${P}`)}):u.elementBoundingBoxes.map((k,P)=>(0,W.jsx)("div",{className:`${A.multiSelectOutline} ${A.enter}`,style:{left:k.x,top:k.y-qe,width:k.width,height:k.height}},`hover-outline-${P}`));let h=rr&&document.contains(rr)?rr.getBoundingClientRect():null,x=h?{x:h.left,y:h.top,width:h.width,height:h.height}:{x:u.boundingBox.x,y:u.isFixed?u.boundingBox.y:u.boundingBox.y-qe,width:u.boundingBox.width,height:u.boundingBox.height},v=u.isMultiSelect;return(0,W.jsx)("div",{className:`${v?A.multiSelectOutline:A.singleSelectOutline} ${A.enter}`,style:{left:x.x,top:x.y,width:x.width,height:x.height,...v?{}:{borderColor:"color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",backgroundColor:"color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"}}})})(),Re&&!X&&!Ye&&!xo&&(0,W.jsxs)("div",{className:`${A.hoverTooltip} ${A.enter}`,style:{left:Math.max(8,Math.min(Ee.x,window.innerWidth-100)),top:Math.max(Ee.y-(Re.reactComponents?48:32),8)},children:[Re.reactComponents&&(0,W.jsx)("div",{className:A.hoverReactPath,children:Re.reactComponents}),(0,W.jsx)("div",{className:A.hoverElementName,children:Re.elementName})]}),X&&(0,W.jsxs)(W.Fragment,{children:[X.multiSelectElements?.length?X.multiSelectElements.filter(u=>document.contains(u)).map((u,h)=>{let x=u.getBoundingClientRect();return(0,W.jsx)("div",{className:`${A.multiSelectOutline} ${Nl?A.exit:A.enter}`,style:{left:x.left,top:x.top,width:x.width,height:x.height}},`pending-multi-${h}`)}):X.targetElement&&document.contains(X.targetElement)?(()=>{let u=X.targetElement.getBoundingClientRect();return(0,W.jsx)("div",{className:`${A.singleSelectOutline} ${Nl?A.exit:A.enter}`,style:{left:u.left,top:u.top,width:u.width,height:u.height,borderColor:"color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",backgroundColor:"color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"}})})():X.boundingBox&&(0,W.jsx)("div",{className:`${X.isMultiSelect?A.multiSelectOutline:A.singleSelectOutline} ${Nl?A.exit:A.enter}`,style:{left:X.boundingBox.x,top:X.boundingBox.y-qe,width:X.boundingBox.width,height:X.boundingBox.height,...X.isMultiSelect?{}:{borderColor:"color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",backgroundColor:"color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"}}}),(()=>{let u=X.x,h=X.isFixed?X.y:X.y-qe;return(0,W.jsxs)(W.Fragment,{children:[(0,W.jsx)(G2,{x:u,y:h,isMultiSelect:X.isMultiSelect,isExiting:Nl}),(0,W.jsx)($a,{ref:o_,element:X.element,selectedText:X.selectedText,computedStyles:X.computedStylesObj,placeholder:X.element==="Area selection"?"What should change in this area?":X.isMultiSelect?"Feedback for this group of elements...":"What should change?",onSubmit:am,onCancel:Xa,isExiting:Nl,lightMode:!ro,accentColor:X.isMultiSelect?"var(--agentation-color-green)":"var(--agentation-color-accent)",style:{left:Math.max(160,Math.min(window.innerWidth-160,u/100*window.innerWidth)),...h>window.innerHeight-290?{bottom:window.innerHeight-h+20}:{top:h+20}}})]})})()]}),Te&&(0,W.jsxs)(W.Fragment,{children:[Te.elementBoundingBoxes?.length?$e.length>0?$e.filter(u=>document.contains(u)).map((u,h)=>{let x=u.getBoundingClientRect();return(0,W.jsx)("div",{className:`${A.multiSelectOutline} ${A.enter}`,style:{left:x.left,top:x.top,width:x.width,height:x.height}},`edit-multi-live-${h}`)}):Te.elementBoundingBoxes.map((u,h)=>(0,W.jsx)("div",{className:`${A.multiSelectOutline} ${A.enter}`,style:{left:u.x,top:u.y-qe,width:u.width,height:u.height}},`edit-multi-${h}`)):(()=>{let u=ue&&document.contains(ue)?ue.getBoundingClientRect():null,h=u?{x:u.left,y:u.top,width:u.width,height:u.height}:Te.boundingBox?{x:Te.boundingBox.x,y:Te.isFixed?Te.boundingBox.y:Te.boundingBox.y-qe,width:Te.boundingBox.width,height:Te.boundingBox.height}:null;return h?(0,W.jsx)("div",{className:`${Te.isMultiSelect?A.multiSelectOutline:A.singleSelectOutline} ${A.enter}`,style:{left:h.x,top:h.y,width:h.width,height:h.height,...Te.isMultiSelect?{}:{borderColor:"color-mix(in srgb, var(--agentation-color-accent) 60%, transparent)",backgroundColor:"color-mix(in srgb, var(--agentation-color-accent) 5%, transparent)"}}}):null})(),(0,W.jsx)($a,{ref:r_,element:Te.element,selectedText:Te.selectedText,computedStyles:Q5(Te.computedStyles),placeholder:"Edit your feedback...",initialValue:Te.comment,submitLabel:"Save",onSubmit:cm,onCancel:dm,onDelete:()=>Qa(Te.id),isExiting:lm,lightMode:!ro,accentColor:Te.isMultiSelect?"var(--agentation-color-green)":"var(--agentation-color-accent)",style:(()=>{let u=Te.isFixed?Te.y:Te.y-qe;return{left:Math.max(160,Math.min(window.innerWidth-160,Te.x/100*window.innerWidth)),...u>window.innerHeight-290?{bottom:window.innerHeight-u+20}:{top:u+20}}})()})]}),xo&&(0,W.jsxs)(W.Fragment,{children:[(0,W.jsx)("div",{ref:$l,className:A.dragSelection}),(0,W.jsx)("div",{ref:Rl,className:A.highlightsContainer})]})]})]}),document.body)}var Fp=_t(Nn(),1),jp=_t(Ap(),1),cx=`
:host {
  all: initial;
  display: block !important;
  position: fixed !important;
  z-index: 2147483647 !important;
  bottom: 0 !important;
  left: 0 !important;
  right: 0 !important;
  pointer-events: none !important;
}

:host * {
  box-sizing: border-box !important;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif !important;
  font-size: 14px !important;
  line-height: 1.5 !important;
  letter-spacing: normal !important;
  word-spacing: normal !important;
}

:host(.agentation-toolbar-active) {
  pointer-events: auto !important;
}
`;function Hp(){let e=window.__TERMUL_AGENTATION_ENDPOINT__,t=window.__TERMUL_AGENTATION_SESSION_ID__;if(e||console.warn("[Agentation] No endpoint configured \u2014 toolbar will not sync annotations"),document.getElementById("termul-agentation-host")?.shadowRoot)return;let o=document.createElement("div");o.id="termul-agentation-host",o.style.cssText="all: initial; position: fixed; z-index: 2147483647; bottom: 0; left: 0; right: 0; pointer-events: none;",document.body.appendChild(o);let r=o.attachShadow({mode:"open"}),l=document.createElement("style");l.textContent=cx,r.appendChild(l);let i=document.createElement("div");i.style.cssText="all: initial;",r.appendChild(i);let s=(0,jp.createRoot)(i);s.render(Fp.default.createElement(zp,{endpoint:e||"http://127.0.0.1:0",sessionId:t,onAnnotationAdd:()=>{o.classList.add("agentation-toolbar-active")}})),window.__TERMUL_AGENTATION_ROOT__=s,window.__TERMUL_AGENTATION_HOST__=o,console.log("[Agentation] Toolbar mounted",{endpoint:e,sessionId:t})}function Up(){if(window.__REACT_DEVTOOLS_GLOBAL_HOOK__)return!0;let e=document.getElementById("root");return!!(e&&e._reactRootContainer||e&&Object.keys(e).some(t=>t.startsWith("__reactFiber"))||window.__NEXT_DATA__||window.___gatsby)}function Wp(){if(Up()){console.log("[Agentation] React page detected \u2014 falling back to vanilla overlay"),window.__TERMUL_USE_VANILLA_OVERLAY__=!0;return}Hp()}function dx(){document.readyState==="loading"?document.addEventListener("DOMContentLoaded",Wp):Wp()}function Yp(){let e=window.__TERMUL_AGENTATION_ROOT__,t=window.__TERMUL_AGENTATION_HOST__;e&&e.unmount(),t?.parentNode&&t.parentNode.removeChild(t)}dx();window.addEventListener("beforeunload",Yp);window.TermulAgentation={mount:Hp,unmount:Yp,isReactPage:Up};})();
/*! Bundled license information:

react/cjs/react.production.min.js:
  (**
   * @license React
   * react.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

scheduler/cjs/scheduler.production.min.js:
  (**
   * @license React
   * scheduler.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react-dom/cjs/react-dom.production.min.js:
  (**
   * @license React
   * react-dom.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)

react/cjs/react-jsx-runtime.production.min.js:
  (**
   * @license React
   * react-jsx-runtime.production.min.js
   *
   * Copyright (c) Facebook, Inc. and its affiliates.
   *
   * This source code is licensed under the MIT license found in the
   * LICENSE file in the root directory of this source tree.
   *)
*/
