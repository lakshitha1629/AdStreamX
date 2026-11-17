// Scoped with the `asx-` prefix. Injected once per document by injectStyles().
export const PLAYER_CSS = /* css */ `
.asx-player{--asx-accent:#22d3ee;--asx-bg:#0b0f17;--asx-fg:#e5e7eb;--asx-muted:#94a3b8;--asx-panel:rgba(15,20,30,.92);
  position:relative;display:block;width:100%;aspect-ratio:16/9;background:#000;color:var(--asx-fg);overflow:hidden;
  font:500 13px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;border-radius:10px;outline:none;user-select:none;-webkit-tap-highlight-color:transparent}
.asx-player:focus-visible{box-shadow:0 0 0 3px var(--asx-accent)}
.asx-player.asx-theater{aspect-ratio:21/9;border-radius:0}
.asx-player:fullscreen,.asx-player:-webkit-full-screen{aspect-ratio:auto;width:100vw;height:100vh;border-radius:0}
.asx-video{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000}
.asx-ui{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:flex-end;pointer-events:none}
.asx-ui>*{pointer-events:auto}
.asx-gesture{position:absolute;inset:0;touch-action:manipulation;cursor:pointer}
.asx-player.asx-idle .asx-gesture{cursor:none}
.asx-top{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;gap:10px;padding:12px 14px;
  background:linear-gradient(rgba(0,0,0,.65),transparent);pointer-events:none;transition:opacity .25s}
.asx-title{font-size:15px;font-weight:600;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.asx-logo{margin-left:auto;max-height:28px;max-width:120px;opacity:.9}
.asx-controls{position:relative;padding:0 10px 8px;background:linear-gradient(transparent,rgba(0,0,0,.8) 60%);transition:opacity .25s,transform .25s}
.asx-player.asx-idle .asx-controls,.asx-player.asx-idle .asx-top{opacity:0;transform:translateY(6px);pointer-events:none}
.asx-player.asx-idle .asx-controls *{pointer-events:none}
.asx-bar{display:flex;align-items:center;gap:2px;height:44px}
.asx-spacer{flex:1}
.asx-btn{appearance:none;border:0;background:transparent;color:var(--asx-fg);width:40px;height:40px;display:inline-grid;place-items:center;
  border-radius:8px;cursor:pointer;padding:0;flex:none}
.asx-btn:hover{background:rgba(255,255,255,.1)}
.asx-btn:focus-visible{outline:2px solid var(--asx-accent);outline-offset:-2px}
.asx-btn svg{width:22px;height:22px;fill:currentColor;display:block}
.asx-btn[data-icon="quality"] svg{width:24px;height:24px} /* gear art is drawn smaller in its box */
.asx-btn[aria-pressed="true"]{color:var(--asx-accent)}
.asx-btn[hidden],.asx-hidden{display:none!important}
.asx-text-btn{width:auto;padding:0 8px;font-weight:600;font-size:12px;letter-spacing:.02em}
.asx-time{font-variant-numeric:tabular-nums;color:var(--asx-fg);padding:0 8px;white-space:nowrap}
.asx-live{display:inline-flex;align-items:center;gap:6px;padding:0 10px;height:28px;border-radius:14px;border:0;
  background:rgba(255,255,255,.12);color:var(--asx-fg);font-weight:700;font-size:12px;letter-spacing:.06em;cursor:pointer}
.asx-live::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--asx-muted)}
.asx-live.asx-at-edge::before{background:#ef4444;box-shadow:0 0 0 3px rgba(239,68,68,.25)}
.asx-live:focus-visible{outline:2px solid var(--asx-accent)}
.asx-latency{color:var(--asx-muted);font-variant-numeric:tabular-nums;padding:0 6px;font-size:12px}
.asx-range{-webkit-appearance:none;appearance:none;background:transparent;cursor:pointer;margin:0;height:20px}
.asx-range:focus-visible{outline:2px solid var(--asx-accent);outline-offset:2px;border-radius:4px}
.asx-range::-webkit-slider-runnable-track{height:4px;border-radius:2px;background:linear-gradient(90deg,var(--asx-accent) 0 var(--asx-pct,0%),rgba(255,255,255,.45) var(--asx-pct,0%) var(--asx-buf,0%),rgba(255,255,255,.2) var(--asx-buf,0%))}
.asx-range::-moz-range-track{height:4px;border-radius:2px;background:linear-gradient(90deg,var(--asx-accent) 0 var(--asx-pct,0%),rgba(255,255,255,.45) var(--asx-pct,0%) var(--asx-buf,0%),rgba(255,255,255,.2) var(--asx-buf,0%))}
.asx-range::-webkit-slider-thumb{-webkit-appearance:none;width:14px;height:14px;margin-top:-5px;border-radius:50%;background:#fff;border:0;transition:transform .1s}
.asx-range::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:#fff;border:0}
.asx-range:hover::-webkit-slider-thumb{transform:scale(1.2)}
.asx-seek{width:100%;display:block}
.asx-volume{width:80px;margin:0 14px 0 2px}
.asx-seek-wrap{position:relative;padding-top:6px}
.asx-seek-tip{position:absolute;bottom:26px;transform:translateX(-50%);background:var(--asx-panel);padding:3px 7px;border-radius:5px;
  font-size:12px;font-variant-numeric:tabular-nums;pointer-events:none;opacity:0;transition:opacity .1s}
.asx-seek-wrap:hover .asx-seek-tip,.asx-seek-wrap.asx-dragging .asx-seek-tip{opacity:1}
.asx-menu{position:absolute;right:10px;bottom:56px;min-width:170px;max-height:60%;overflow:auto;background:var(--asx-panel);border-radius:10px;
  padding:6px;box-shadow:0 10px 30px rgba(0,0,0,.5);z-index:5}
.asx-menu-title{padding:6px 10px;color:var(--asx-muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.asx-menu-item{display:flex;width:100%;align-items:center;gap:8px;border:0;background:transparent;color:var(--asx-fg);text-align:left;
  padding:8px 10px;border-radius:6px;cursor:pointer;font:inherit}
.asx-menu-item:hover,.asx-menu-item:focus-visible{background:rgba(255,255,255,.1);outline:none}
.asx-menu-item[aria-checked="true"]{color:var(--asx-accent)}
.asx-menu-item[aria-checked="true"]::after{content:"✓";margin-left:auto}
.asx-menu-note{padding:6px 10px;color:var(--asx-muted);font-size:12px;max-width:220px}
.asx-center{position:absolute;inset:0;display:grid;place-items:center;pointer-events:none}
.asx-bigplay{pointer-events:auto;width:76px;height:76px;border-radius:50%;border:0;background:rgba(0,0,0,.55);color:#fff;cursor:pointer;
  display:grid;place-items:center;transition:transform .15s,background .15s}
.asx-bigplay:hover{transform:scale(1.06);background:var(--asx-accent);color:#001018}
.asx-bigplay:focus-visible{outline:3px solid var(--asx-accent)}
/* the play path is drawn so its centroid sits at the centre: no manual nudge needed */
.asx-bigplay svg{width:36px;height:36px;fill:currentColor;display:block}
.asx-spinner{width:54px;height:54px;border-radius:50%;border:4px solid rgba(255,255,255,.2);border-top-color:var(--asx-accent);animation:asx-spin .9s linear infinite}
@keyframes asx-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.asx-spinner{animation-duration:2.5s}.asx-controls,.asx-top{transition:none}}
.asx-error{pointer-events:auto;max-width:min(420px,86%);max-height:90%;overflow:auto;text-align:center;background:var(--asx-panel);padding:18px 20px;border-radius:12px}
.asx-error-title{font-size:15px;font-weight:600;margin-bottom:6px}
.asx-error-code{color:var(--asx-muted);font-size:11px;margin-top:6px;font-family:ui-monospace,monospace}
.asx-error-retry{margin-top:12px;border:0;border-radius:8px;padding:8px 16px;background:var(--asx-accent);color:#001018;font-weight:700;cursor:pointer}
.asx-error-retry:focus-visible{outline:2px solid #fff;outline-offset:2px}
.asx-flash{position:absolute;top:50%;transform:translateY(-50%);padding:10px 14px;border-radius:24px;background:rgba(0,0,0,.6);font-weight:700;pointer-events:none;opacity:0;transition:opacity .2s}
.asx-flash.asx-show{opacity:1}
.asx-flash-left{left:12%}.asx-flash-right{right:12%}
.asx-sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
@media (max-width:560px){.asx-error{padding:10px 12px;font-size:12px}.asx-error-title{font-size:13px}.asx-error-retry{margin-top:8px;padding:6px 12px}
  .asx-volume{display:none}.asx-btn{width:36px;height:36px}.asx-bar{height:40px}.asx-hide-narrow{display:none!important}}
`;

export function injectStyles(doc: Document = document): void {
  if (doc.getElementById('asx-styles')) return;
  const style = doc.createElement('style');
  style.id = 'asx-styles';
  style.textContent = PLAYER_CSS;
  doc.head.appendChild(style);
}
