// Injected into every page before its own scripts run. Draws a visible cursor,
// click ripples, an optional caption and an optional highlight ring.
// Automated input never moves the real mouse pointer, so without this the
// recording would show clicks landing with no cursor. Uses only DOM/CSSOM
// calls (no innerHTML, no <style>) so strict CSP pages still render it.
export function overlayScript() {
  if (window.top !== window || window.__demo) return;

  const css = (el, text) => { el.style.cssText = text; return el; };
  const host = css(document.createElement('div'),
    'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;');
  host.setAttribute('data-demo-overlay', '');
  const root = host.attachShadow ? host.attachShadow({ mode: 'closed' }) : host;

  const NS = 'http://www.w3.org/2000/svg';
  const cursor = document.createElementNS(NS, 'svg');
  cursor.setAttribute('width', '28');
  cursor.setAttribute('height', '28');
  cursor.setAttribute('viewBox', '0 0 28 28');
  css(cursor, 'position:fixed;left:0;top:0;display:none;pointer-events:none;' +
    'filter:drop-shadow(0 1px 2px rgba(0,0,0,.45));will-change:transform;');
  const arrow = document.createElementNS(NS, 'path');
  arrow.setAttribute('d', 'M3 2 L3 22 L8.5 17 L12 25 L15.5 23.5 L12 15.8 L19.5 15.8 Z');
  arrow.setAttribute('fill', '#111');
  arrow.setAttribute('stroke', '#fff');
  arrow.setAttribute('stroke-width', '1.6');
  arrow.setAttribute('stroke-linejoin', 'round');
  cursor.appendChild(arrow);

  const caption = css(document.createElement('div'),
    'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);display:none;' +
    'max-width:72vw;padding:10px 18px;border-radius:10px;background:rgba(17,17,17,.9);' +
    'color:#fff;font:600 18px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;' +
    'text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.3);pointer-events:none;');

  const ring = css(document.createElement('div'),
    'position:fixed;display:none;border:3px solid #ff3b6b;border-radius:8px;' +
    'box-shadow:0 0 0 4px rgba(255,59,107,.25);pointer-events:none;');

  root.append(ring, caption, cursor);

  const api = {
    move(x, y) {
      cursor.style.display = 'block';
      cursor.style.transform = `translate(${x - 3}px, ${y - 2}px)`;
    },
    ripple(x, y) {
      const dot = css(document.createElement('div'),
        `position:fixed;left:${x - 16}px;top:${y - 16}px;width:32px;height:32px;` +
        'border-radius:50%;background:rgba(255,59,107,.45);pointer-events:none;');
      root.insertBefore(dot, cursor);
      const anim = dot.animate(
        [{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.6)', opacity: 0 }],
        { duration: 450, easing: 'ease-out' },
      );
      anim.onfinish = () => dot.remove();
    },
    caption(text) {
      caption.textContent = text || '';
      caption.style.display = text ? 'block' : 'none';
    },
    highlight(rect) {
      if (!rect) { ring.style.display = 'none'; return; }
      ring.style.display = 'block';
      ring.style.left = `${rect.x - 6}px`;
      ring.style.top = `${rect.y - 6}px`;
      ring.style.width = `${rect.width + 6}px`;
      ring.style.height = `${rect.height + 6}px`;
    },
  };
  Object.defineProperty(window, '__demo', { value: api, configurable: true });

  document.addEventListener('mousemove', (e) => api.move(e.clientX, e.clientY), true);
  document.addEventListener('mousedown', (e) => api.ripple(e.clientX, e.clientY), true);

  const mount = () => {
    if (!document.documentElement) return false;
    if (!host.isConnected) document.documentElement.appendChild(host);
    return true;
  };
  if (!mount()) document.addEventListener('readystatechange', mount);
  document.addEventListener('DOMContentLoaded', mount);
}
