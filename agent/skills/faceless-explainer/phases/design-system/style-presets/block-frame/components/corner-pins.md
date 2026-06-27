```html
<div class="bf-corner-pins">
  <div class="bf-corner-pin bf-corner-pin-tl"></div>
  <div class="bf-corner-pin bf-corner-pin-tr"></div>
  <div class="bf-corner-pin bf-corner-pin-bl"></div>
  <div class="bf-corner-pin bf-corner-pin-br"></div>
</div>

<style>
  .bf-corner-pins {
    position: relative;
    width: 100%;
    height: 100%;
    min-width: 240px;
    min-height: 160px;
  }
  .bf-corner-pin {
    position: absolute;
    width: 28px;
    height: 28px;
    border: var(--bf-border-mid);
  }
  .bf-corner-pin-tl {
    top: 0;
    left: 0;
    border-right: none;
    border-bottom: none;
  }
  .bf-corner-pin-tr {
    top: 0;
    right: 0;
    border-left: none;
    border-bottom: none;
  }
  .bf-corner-pin-bl {
    bottom: 0;
    left: 0;
    border-right: none;
    border-top: none;
  }
  .bf-corner-pin-br {
    bottom: 0;
    right: 0;
    border-left: none;
    border-top: none;
  }
</style>
```
