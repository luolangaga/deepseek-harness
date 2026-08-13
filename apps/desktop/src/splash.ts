/** The static splash page served while the host boots (the window paints immediately; the real index replaces it on settle). */

export const SPLASH_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>DeepSeek Harness</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body {
        display: flex; flex-direction: column; gap: 20px;
        align-items: center; justify-content: center;
        background: #101014; color: #e8e8ea;
        font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      .mark { width: 34px; height: 34px; border-radius: 10px; background: linear-gradient(135deg, #4d6bfe, #7a5cff); }
      .spin {
        width: 22px; height: 22px; border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.16); border-top-color: #7a8cff;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
      .label { color: #9a9aa2; }
    </style>
  </head>
  <body>
    <div class="mark"></div>
    <div class="spin"></div>
    <div class="label">DeepSeek Harness is starting…</div>
  </body>
</html>
`
