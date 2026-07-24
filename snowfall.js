// ==========================================
// ❄️ SNOWFALL — subtle ambient background animation
// Drop this file in as snowfall.js and add:
//   <script src="snowfall.js"></script>
// right before your closing </body> tag in index.html (after app.js is fine
// too — this is fully independent and self-initializing).
//
// Renders on a single <canvas>, fixed behind all app content, and keeps
// running across every page since it's created once at load and never
// torn down by the app's router.
// ==========================================

(function () {
    'use strict';

    // ─── TUNE THESE TO TASTE ───────────────────────────────
    const CONFIG = {
        flakeCount: 120,         // total flakes on screen at once (subtle: 30-50, festive: 100+)
        minRadius: 1.2,          // smallest flake size, px
        maxRadius: 3.2,          // largest flake size, px
        minSpeed: 0.35,          // slowest fall speed, px/frame
        maxSpeed: 1.1,           // fastest fall speed, px/frame
        minOpacity: 0.15,        // faintest flake opacity
        maxOpacity: 0.55,        // most visible flake opacity
        swayAmount: 0.6,         // how much side-to-side drift, px/frame
        color: '255, 255, 255',  // RGB as a string — flakes are white by default
        respectReducedMotion: true // if true, disables entirely for users who
                                    // have "reduce motion" set in their OS/browser
    };
    // ────────────────────────────────────────────────────────

    function init() {
        if (CONFIG.respectReducedMotion &&
            window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            return; // respect accessibility preference, skip entirely
        }

        if (document.getElementById('snowfall-canvas')) return; // already running

        const canvas = document.createElement('canvas');
        canvas.id = 'snowfall-canvas';
        canvas.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100vw;
            height: 100vh;
            pointer-events: none;
            z-index: 2147483647;
        `;
        document.body.appendChild(canvas);

        const ctx = canvas.getContext('2d');
        let width, height;
        let flakes = [];
        let animationId = null;
        let isTabVisible = true;

        function resize() {
            width = canvas.width = window.innerWidth;
            height = canvas.height = window.innerHeight;
        }

        function makeFlake() {
            return {
                x: Math.random() * width,
                y: Math.random() * height,
                radius: CONFIG.minRadius + Math.random() * (CONFIG.maxRadius - CONFIG.minRadius),
                speed: CONFIG.minSpeed + Math.random() * (CONFIG.maxSpeed - CONFIG.minSpeed),
                opacity: CONFIG.minOpacity + Math.random() * (CONFIG.maxOpacity - CONFIG.minOpacity),
                swayPhase: Math.random() * Math.PI * 2,
                swaySpeed: 0.005 + Math.random() * 0.01
            };
        }

        function initFlakes() {
            flakes = Array.from({ length: CONFIG.flakeCount }, makeFlake);
        }

        function tick() {
            if (!isTabVisible) {
                animationId = requestAnimationFrame(tick);
                return;
            }
            ctx.clearRect(0, 0, width, height);
            flakes.forEach(f => {
                f.y += f.speed;
                f.swayPhase += f.swaySpeed;
                f.x += Math.sin(f.swayPhase) * CONFIG.swayAmount * 0.05;

                if (f.y > height + f.radius) {
                    f.y = -f.radius;
                    f.x = Math.random() * width;
                }
                if (f.x > width + f.radius) f.x = -f.radius;
                if (f.x < -f.radius) f.x = width + f.radius;

                ctx.beginPath();
                ctx.arc(f.x, f.y, f.radius, 0, Math.PI * 2);
                ctx.fillStyle = `rgba(${CONFIG.color}, ${f.opacity})`;
                ctx.fill();
            });
            animationId = requestAnimationFrame(tick);
        }

        // Pause animation when the tab isn't visible — saves battery/CPU,
        // and avoids a jarring jump when the user comes back.
        document.addEventListener('visibilitychange', () => {
            isTabVisible = !document.hidden;
        });

        window.addEventListener('resize', resize);

        resize();
        initFlakes();
        tick();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
