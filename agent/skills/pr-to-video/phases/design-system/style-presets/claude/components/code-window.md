```html
<!--
  The signature navy product chrome — "show the code, not a cartoon of the code."
  Title bar (3 dots + filename), gutter line numbers, syntax-tokened code, status
  strip. Worker edits the code lines directly (this is structure, not a slot); the
  filename rides in {LABEL}. Token spans: .k coral keyword · .s teal string ·
  .n amber number · .c muted comment — the same palette as outside the window.
-->
<div class="cl-code-window">
  <div class="cl-code-bar">
    <i></i><i></i><i></i>
    <span class="cl-code-file">{LABEL}</span>
  </div>
  <div class="cl-code-body">
    <div class="cl-code-gutter">
      <span>01</span><span>02</span><span>03</span><span>04</span><span>05</span>
    </div>
    <pre class="cl-code-src"><span class="c"># read the whole thing before answering</span>
<span class="k">def</span> answer(question):
    context = retrieve(question)
    <span class="k">return</span> model.reason(context, depth=<span class="n">3</span>)
<span class="c"># helpful, harmless, honest &mdash; in that order</span></pre>
  </div>
  <div class="cl-code-status"><span class="cl-code-dot"></span> ready</div>
</div>

<style>
  .cl-code-window {
    background: var(--cl-navy);
    border-radius: var(--cl-radius-md);
    overflow: hidden;
    display: grid;
    grid-template-rows: 56px 1fr 52px;
    border: 1px solid var(--cl-hairline-dark);
  }
  .cl-code-bar {
    background: var(--cl-navy-elev);
    border-bottom: 1px solid var(--cl-hairline-dark);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 24px;
  }
  .cl-code-bar i {
    width: 14px;
    height: 14px;
    border-radius: var(--cl-radius-pill);
    background: var(--cl-on-dark-soft);
    opacity: 0.45;
  }
  .cl-code-bar i:first-child {
    background: var(--brand-accent);
    opacity: 0.85;
  }
  .cl-code-bar i:nth-child(2) {
    background: var(--cl-amber);
    opacity: 0.85;
  }
  .cl-code-bar i:nth-child(3) {
    background: var(--cl-success);
    opacity: 0.85;
  }
  .cl-code-file {
    margin-left: 16px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-weight: 500;
    font-size: 24px;
    letter-spacing: 0.02em;
    color: var(--cl-on-dark-soft);
  }
  .cl-code-body {
    display: grid;
    grid-template-columns: 64px 1fr;
    padding: 28px 0;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 26px;
    line-height: 1.7;
  }
  .cl-code-gutter {
    text-align: right;
    padding-right: 16px;
    border-right: 1px solid var(--cl-hairline-dark);
    color: color-mix(in srgb, var(--cl-on-dark) 36%, var(--cl-navy));
  }
  .cl-code-gutter span {
    display: block;
  }
  .cl-code-src {
    margin: 0;
    padding-left: 24px;
    white-space: pre;
    color: var(--cl-on-dark);
  }
  .cl-code-src .k {
    color: var(--brand-accent);
  }
  .cl-code-src .s {
    color: var(--cl-teal);
  }
  .cl-code-src .n {
    color: var(--cl-amber);
  }
  .cl-code-src .c {
    color: var(--cl-on-dark-soft);
    font-style: italic;
  }
  .cl-code-status {
    background: var(--cl-navy-elev);
    border-top: 1px solid var(--cl-hairline-dark);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 24px;
    font-family: "JetBrains Mono", ui-monospace, monospace;
    font-size: 24px;
    color: var(--cl-on-dark-soft);
  }
  .cl-code-dot {
    width: 12px;
    height: 12px;
    border-radius: var(--cl-radius-pill);
    background: var(--cl-teal);
  }
</style>
```
