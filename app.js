// ==========================================
// MMC DISPATCH OS — app.js
// Features: Kanban, Drawer UI, Smart Search, Supabase Realtime
// ==========================================

let currentUser = null;
let currentOrgId = null;

// Populated at runtime by loadStepConfig() from the step_definitions table —
// BMH's 6-step workflow (PI → Payment → Packing → Transport → LR), not
// hardcoded MMC steps. Colors/icons aren't in the DB, so they're assigned
// client-side from a fixed palette by position.
let stepsDirectory = [];
let stepLabels = {};

const STEP_VISUAL_PALETTE = [
    { color: '#3b82f6', icon: 'file-text' },      // STEP2_PI_CREATED
    { color: '#8b5cf6', icon: 'check-circle' },   // STEP3_PAYMENT_CONFIRMED
    { color: '#ec4899', icon: 'send' },           // STEP4_SENT_TO_PACKING
    { color: '#f97316', icon: 'package' },        // STEP5_PACKING_DONE
    { color: '#10b981', icon: 'banknote' },       // STEP6_TRANSPORT_CHARGES
    { color: '#0284c7', icon: 'truck' },          // STEP7_LR_GENERATED
];

async function loadStepConfig() {
    const defs = await window.db.getStepDefinitions();
    // STEP1 is excluded — it's marked DONE automatically by the create_order
    // RPC (the order form submission IS step1), so it's never a user-submittable
    // step in the drawer/kanban.
    const submittable = defs.filter(d => d.step_code !== 'STEP1_ORDER_RECEIVED');

    stepsDirectory = submittable.map(d => d.step_code);
    stepLabels = {};
    submittable.forEach((d, i) => {
        const visual = STEP_VISUAL_PALETTE[i] || { color: '#4f46e5', icon: 'circle' };
        stepLabels[d.step_code] = {
            en: d.step_name,
            hi: d.step_name,
            color: visual.color,
            icon: visual.icon,
            needsEvidence: true,   // every BMH step requires a proof upload
            formCode: d.form_code,
            slaHours: d.sla_hours,
            ownerRole: d.owner_role
        };
    });
}

// ─── STEP HELPERS ──────────────────────
// No per-step Hinglish hint copy for BMH (forms are generic) — shows the
// responsible role + form code + SLA instead.
function stepHint(code) {
    const cfg = stepLabels[code];
    return cfg ? `${cfg.ownerRole.toUpperCase()} · Form ${cfg.formCode} · SLA ${cfg.slaHours}h` : '';
}

function stepName(code) {
    return stepLabels[code]?.en || code;
}

// Real global mobile-detection function — PullToRefresh.init() calls this.
// (Pre-existing bug in the original file: isMobile was only ever a local
// variable computed inline elsewhere, never a real function, so this call
// always threw ReferenceError before this fix.)
function isMobile() {
    const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    const isMobileWidth = window.innerWidth < 768;
    const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    return isMobileUA || isMobileWidth || (isTouchDevice && window.innerWidth < 1024);
}

// ==========================================
// INIT & REALTIME
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
    lucide.createIcons();
    const session = await window.db.getSession();
    if (session) {
        currentUser = await window.db.getCurrentUserExt();
        if (!currentUser) {
            showToast('User record not found. Contact Admin.', 'error');
            await window.db.logout();
            location.hash = '#/login';
        } else {
            currentOrgId = currentUser.organization_id;
            await loadStepConfig();   // must resolve before router() renders any step-related UI
            setupRealtime();
            
            // 📱 Auto-detect mobile — MULTIPLE checks
            const forcedDesktop = localStorage.getItem('bmh_force_desktop') === '1';
            const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
            const isMobileWidth = window.innerWidth < 768;
            const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
            const isPWA = window.matchMedia('(display-mode: standalone)').matches;

            // A user who explicitly picked "Desktop View" stays on desktop even
            // inside an installed PWA window — isPWA alone used to force mobile
            // mode unconditionally, which fought the user's own choice on every reload.
            const isMobile = !forcedDesktop && (isMobileUA || isMobileWidth || isPWA || (isTouchDevice && window.innerWidth < 1024));

            if (isMobile && !location.hash.startsWith('#/mobile') && location.hash !== '#/login') {
                console.log('📱 Mobile detected, redirecting...');
                location.hash = '#/mobile/orders';
            }
        }
    }
    window.addEventListener('hashchange', router);
    router();
});

// Real-time, event-driven updates — Supabase pushes a message the instant
// a row changes; nothing here polls or re-hits the API on a timer. Covers:
// new orders, step completions, and new evidence/proof submissions —
// refreshing whichever view is currently open (dashboard/orders/board/
// mobile list), plus the order drawer itself if it's open on the affected order.
function setupRealtime() {
    let __realtimeTimer = null;
    const debouncedRefresh = () => {
        clearTimeout(__realtimeTimer);
        __realtimeTimer = setTimeout(refreshCurrentView_, 800);
    };

    window.db.supabase.channel('public:orders')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, (payload) => {
            debouncedRefresh();
            refreshOpenDrawerIfMatches_(payload.new?.id || payload.old?.id);
        }).subscribe();

    window.db.supabase.channel('public:order_step_status')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'order_step_status' }, (payload) => {
            debouncedRefresh();
            refreshOpenDrawerIfMatches_(payload.new?.order_id || payload.old?.order_id);
        }).subscribe();

    // New evidence/proof lands here — this is what was previously NOT
    // being listened to at all, so a submitted step's file/notes wouldn't
    // trigger anything on their own beyond the order_step_status row change.
    window.db.supabase.channel('public:step_submissions')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'step_submissions' }, (payload) => {
            debouncedRefresh();
            refreshOpenDrawerIfMatches_(payload.new?.order_id);
        }).subscribe();
}

function refreshCurrentView_() {
    // Skip if a modal is actively open — don't yank the screen from under a user mid-form.
    if (document.querySelector('#step-modal')) return;
    const hash = location.hash || '#/dashboard';
    if (hash === '#/mobile/orders') {
        renderMobileOrders(document.getElementById('main-content'));
    } else if (['#/orders', '#/dashboard', '#/board'].includes(hash)) {
        router();
    }
}

function refreshOpenDrawerIfMatches_(orderId) {
    if (!orderId) return;
    const openId = document.getElementById('order-drawer')?.dataset?.orderId;
    if (openId === orderId) openOrderDrawer(orderId);
}

// One-shot catch-up when the tab regains focus (e.g. after being backgrounded
// long enough for the websocket to lapse) — not a repeating timer.
document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshCurrentView_();
});

// ==========================================
// ROUTER
// ==========================================
async function router() {
    const hash = location.hash || '#/dashboard';
    const app = document.getElementById('app');

    if (!currentUser && hash !== '#/login') {
        location.hash = '#/login';
        return;
    }

    if (hash === '#/login') {
        app.innerHTML = renderLoginUI();
        lucide.createIcons();
    } else {
        app.innerHTML = `
            ${renderSidebar()}
            <div class="flex-1 flex flex-col min-w-0 overflow-hidden">
                ${renderTopbar()}
                <main id="main-content" class="flex-1 overflow-y-auto p-6 bg-gray-50 relative"></main>
            </div>
            <div id="drawer-root"></div>
        `;
        lucide.createIcons();

        const main = document.getElementById('main-content');

        if (hash === '#/dashboard') await renderDashboard(main);
        else if (hash === '#/board') await renderKanban(main);
        else if (hash === '#/orders') await renderOrders(main);
        else if (hash === '#/orders/new') await renderNewOrder(main);
        else if (hash === '#/customers') await renderCustomers(main);
        else if (hash === '#/analytics') await renderAnalytics(main);
        else if (hash === '#/mobile') await renderMobileHome(main);
        else if (hash === '#/mobile/orders') await renderMobileOrders(main);
        else main.innerHTML = '<div class="p-8 text-center text-gray-500">Page not found.</div>';
        
        lucide.createIcons();
    }
}

// ==========================================
// SIDEBAR + TOPBAR
// ==========================================
function renderSidebar() {
    const path = location.hash || '#/dashboard';
    const navItem = (href, icon, label, isActive) => `
        <a href="${href}" class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/10 transition-colors ${isActive ? 'bg-indigo-600 shadow-md text-white' : 'text-indigo-100'}">
            <i data-lucide="${icon}" class="w-5 h-5"></i> ${label}
        </a>`;
        
    return `
        <aside class="w-64 sidebar-gradient text-white flex flex-col h-full hidden md:flex shadow-xl z-20">
            <div class="p-6 flex items-center gap-3 border-b border-white/10">
                <img src="/web-app-manifest-192x192.png" alt="Bansal Metrial House" class="w-10 h-10 rounded-lg">
                <h1 class="font-bold text-xl tracking-tight text-white">BMH Dispatch</h1>
            </div>
            <nav class="flex-1 px-4 py-6 space-y-1.5">
                <div class="text-[10px] text-white/40 font-bold uppercase tracking-wider mb-2 px-2">Workspace</div>
                ${navItem('#/dashboard', 'layout-dashboard', t('dashboard'), path.includes('dashboard'))}
                ${navItem('#/board', 'kanban', t('kanban'), path.includes('/board'))}
                ${navItem('#/orders', 'shopping-cart', t('orders'), path.includes('orders') && !path.includes('new'))}
                ${navItem('#/customers', 'users', 'Customers', path.includes('customers'))}
                ${navItem('#/analytics', 'bar-chart-3', 'Analytics', path.includes('analytics'))}
            </nav>
            <div class="p-4 bg-black/20 backdrop-blur-sm m-4 rounded-xl border border-white/10">
                <div class="flex items-center gap-3">
                    <div class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shadow-inner" style="background-color: ${currentUser?.avatar_color || '#4f46e5'}">
                        ${currentUser?.full_name?.substring(0,2).toUpperCase() || 'U'}
                    </div>
                    <div class="flex-1 min-w-0">
                        <p class="text-sm font-semibold truncate text-white">${currentUser?.full_name}</p>
                        <p class="text-xs text-indigo-200 truncate capitalize">${currentUser?.role}</p>
                    </div>
                    <button onclick="handleLogout()" class="text-indigo-300 hover:text-white transition"><i data-lucide="log-out" class="w-5 h-5"></i></button>
                </div>
            </div>
        </aside>`;
}

function renderTopbar() {
    const lang = localStorage.getItem('mmc_lang') || 'en';
    return `
        <header class="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between sticky top-0 z-10 shadow-sm">
            <div class="flex items-center gap-4 flex-1">
                <div class="relative w-64 md:w-96">
                    <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"></i>
                    <input type="text" id="global-search" placeholder="${t('search_placeholder')}"
                           oninput="handleGlobalSearch(event)"
                           onfocus="handleGlobalSearchFocus()"
                           autocomplete="off"
                           class="w-full pl-9 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg focus:bg-white focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 text-sm transition-all outline-none">
                    <div id="search-dropdown" class="hidden absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-2xl max-h-96 overflow-y-auto z-50"></div>
                </div>
            </div>
            <div class="flex items-center gap-3">
                <button onclick="toggleLanguage()" class="px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded-md text-sm font-semibold hover:bg-gray-200 transition">
                    ${lang === 'hi' ? 'EN' : 'हिंदी'}
                </button>
                <a href="#/orders/new" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-indigo-700 shadow-md shadow-indigo-600/20 flex items-center gap-2 transition-all hover:-translate-y-0.5">
                    <i data-lucide="plus" class="w-4 h-4"></i> ${t('new_order')}
                </a>
            </div>
        </header>`;
}

// ==========================================
// 🔍 GLOBAL SEARCH (smart, debounced, multi-table)
// ==========================================
let searchTimer = null;
window.handleGlobalSearch = function(e) {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    const dropdown = document.getElementById('search-dropdown');

    if (q.length < 2) {
        dropdown.classList.add('hidden');
        return;
    }

    dropdown.innerHTML = `<div class="p-4 text-center text-sm text-gray-500"><div class="spinner mx-auto"></div></div>`;
    dropdown.classList.remove('hidden');

    searchTimer = setTimeout(async () => {
        try {
            const results = await window.db.globalSearch(q);
            renderSearchResults(results, q);
        } catch (err) {
            console.error(err);
            dropdown.innerHTML = `<div class="p-4 text-center text-sm text-red-500">Search failed</div>`;
        }
    }, 300);
};

window.handleGlobalSearchFocus = function() {
    const input = document.getElementById('global-search');
    if (input.value.trim().length >= 2) {
        document.getElementById('search-dropdown').classList.remove('hidden');
    }
};

document.addEventListener('click', (e) => {
    if (!e.target.closest('#global-search') && !e.target.closest('#search-dropdown')) {
        document.getElementById('search-dropdown')?.classList.add('hidden');
    }
});

function renderSearchResults(results, query) {
    const dropdown = document.getElementById('search-dropdown');
    const { orders = [], customers = [] } = results;

    if (orders.length === 0 && customers.length === 0) {
        dropdown.innerHTML = `<div class="p-6 text-center text-sm text-gray-400"><i data-lucide="search-x" class="w-8 h-8 mx-auto mb-2"></i><p>No results for "${escapeHtml(query)}"</p></div>`;
        lucide.createIcons();
        return;
    }

    let html = '';

    if (orders.length > 0) {
        html += `<div class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">Orders (${orders.length})</div>`;
        orders.forEach(o => {
            html += `
                <div onclick="closeSearchDropdown(); openOrderDrawer('${o.id}')" class="flex items-center gap-3 px-3 py-2.5 hover:bg-indigo-50 cursor-pointer border-b border-gray-50">
                    <div class="w-8 h-8 bg-indigo-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <i data-lucide="package" class="w-4 h-4 text-indigo-600"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-mono font-bold text-xs text-indigo-600">${o.order_code}</span>
                            <span class="font-bold text-sm text-gray-900 truncate">${highlightMatch(o.customer_name, query)}</span>
                        </div>
                        <div class="text-[11px] text-gray-500 mt-0.5">₹${formatINR(o.order_value)} · ${o.current_step ? stepName(o.current_step) : 'Completed'}</div>
                    </div>
                    ${o.is_delayed ? '<span class="text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">DELAYED</span>' : ''}
                </div>`;
        });
    }

    if (customers.length > 0) {
        html += `<div class="px-3 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider bg-gray-50 border-b border-gray-100">Customers (${customers.length})</div>`;
        customers.forEach(c => {
            html += `
                <div onclick="closeSearchDropdown(); openCustomerDrawer('${c.id}')" class="flex items-center gap-3 px-3 py-2.5 hover:bg-violet-50 cursor-pointer border-b border-gray-50">
                    <div class="w-8 h-8 bg-violet-50 rounded-lg flex items-center justify-center flex-shrink-0">
                        <i data-lucide="user" class="w-4 h-4 text-violet-600"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-sm text-gray-900 truncate">${highlightMatch(c.name, query)}</div>
                        <div class="text-[11px] text-gray-500 mt-0.5">${c.phone || '—'} · ${c.total_orders || 0} orders</div>
                    </div>
                </div>`;
        });
    }

    dropdown.innerHTML = html;
    lucide.createIcons();
}

window.closeSearchDropdown = function() {
    document.getElementById('search-dropdown')?.classList.add('hidden');
    document.getElementById('global-search').value = '';
};

function highlightMatch(text, query) {
    if (!text) return '';
    const escaped = escapeHtml(text);
    const safeQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.replace(new RegExp(`(${safeQuery})`, 'gi'), '<mark class="bg-yellow-200 text-gray-900 font-bold">$1</mark>');
}

function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ==========================================
// LOGIN
// ==========================================
function renderLoginUI() {
    return `
        <div class="flex-1 flex h-full min-h-screen">

            <!-- ── LEFT BRAND PANEL (hidden on mobile) ── -->
            <div class="hidden md:flex flex-col justify-between w-[48%] max-w-xl relative overflow-hidden"
                 style="background: linear-gradient(155deg, #0f172a 0%, #1e1b4b 55%, #312e81 100%);">

                <!-- Subtle dot-grid overlay -->
                <div class="absolute inset-0 pointer-events-none" style="
                    background-image: radial-gradient(rgba(255,255,255,0.07) 1px, transparent 1px);
                    background-size: 28px 28px;"></div>

                <!-- Glow orbs -->
                <div class="absolute -top-24 -left-24 w-72 h-72 rounded-full pointer-events-none"
                     style="background: radial-gradient(circle, rgba(99,102,241,0.3) 0%, transparent 70%);"></div>
                <div class="absolute bottom-0 right-0 w-96 h-96 rounded-full pointer-events-none"
                     style="background: radial-gradient(circle, rgba(124,58,237,0.25) 0%, transparent 70%);"></div>

                <!-- Brand content -->
                <div class="relative z-10 p-10 pt-14">
                    <div class="flex items-center gap-3 mb-12">
                        <img src="/web-app-manifest-192x192.png" alt="MMC"
                             class="w-10 h-10 rounded-xl shadow-lg shadow-black/40">
                        <div>
                            <div class="text-white font-extrabold text-lg leading-tight">BMH Dispatch</div>
                            <div class="text-indigo-300 text-xs font-semibold tracking-widest uppercase">Dispatch OS</div>
                        </div>
                    </div>

                    <h1 class="text-white text-3xl font-extrabold leading-snug mb-4">
                        Your orders.<br>Your team.<br>
                        <span style="background: linear-gradient(90deg,#a5b4fc,#c4b5fd); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">One place.</span>
                    </h1>
                    <p class="text-indigo-200 text-sm leading-relaxed mb-10 max-w-xs">
                        End-to-end dispatch workflow — from new order to tracking shared — all in a single, fast interface.
                    </p>

                    <div class="space-y-4">
                        ${[
                            ['zap',       'Real-time order tracking',         'Live updates as orders move through stages'],
                            ['users',     'Team collaboration',               'Assign, notify and coordinate instantly'],
                            ['bar-chart-2','Analytics at a glance',          'KPIs, delivery stats and performance trends'],
                        ].map(([icon, title, sub]) => `
                            <div class="flex items-start gap-3">
                                <div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0"
                                     style="background:rgba(99,102,241,0.25);">
                                    <i data-lucide="${icon}" class="w-4 h-4 text-indigo-300"></i>
                                </div>
                                <div>
                                    <div class="text-white text-sm font-semibold">${title}</div>
                                    <div class="text-indigo-300/70 text-xs mt-0.5">${sub}</div>
                                </div>
                            </div>`).join('')}
                    </div>
                </div>

                <div class="relative z-10 px-10 pb-8 text-indigo-400/50 text-xs">
                    © ${new Date().getFullYear()} Bansal Metrial House · All rights reserved
                </div>
            </div>

            <!-- ── RIGHT FORM PANEL ── -->
            <div class="flex-1 flex flex-col items-center justify-center bg-white px-6 py-12 relative">

                <!-- Mobile-only logo -->
                <div class="flex md:hidden items-center gap-2.5 mb-8">
                    <img src="/web-app-manifest-192x192.png" alt="MMC" class="w-9 h-9 rounded-xl shadow">
                    <div>
                        <div class="text-gray-900 font-extrabold text-base leading-tight">BMH Dispatch</div>
                        <div class="text-indigo-500 text-[10px] font-bold tracking-widest uppercase">Dispatch OS</div>
                    </div>
                </div>

                <div class="w-full max-w-sm">
                    <div class="mb-8">
                        <h2 class="text-2xl font-extrabold text-gray-900">Welcome back</h2>
                        <p class="text-gray-500 text-sm mt-1">Sign in to your workspace</p>
                    </div>

                    <form onsubmit="handleLogin(event)" class="space-y-5">

                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1.5">Email address</label>
                            <input type="email" id="email" required autocomplete="email"
                                placeholder="you@company.com"
                                class="w-full px-4 py-3 bg-gray-50 border border-gray-200 rounded-xl text-sm
                                       focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 outline-none transition placeholder-gray-400">
                        </div>

                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1.5">Password</label>
                            <div class="relative">
                                <input type="password" id="password" required autocomplete="current-password"
                                    placeholder="••••••••"
                                    class="w-full px-4 py-3 pr-11 bg-gray-50 border border-gray-200 rounded-xl text-sm
                                           focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 outline-none transition placeholder-gray-400">
                                <button type="button" onclick="
                                    const p=document.getElementById('password');
                                    const i=this.querySelector('i');
                                    if(p.type==='password'){p.type='text';i.setAttribute('data-lucide','eye-off');}
                                    else{p.type='password';i.setAttribute('data-lucide','eye');}
                                    lucide.createIcons();"
                                    class="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 transition p-1">
                                    <i data-lucide="eye" class="w-4 h-4"></i>
                                </button>
                            </div>
                        </div>

                        <button type="submit" id="login_btn"
                            class="w-full py-3 rounded-xl font-bold text-sm text-white flex items-center justify-center gap-2 transition-all"
                            style="background: linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%);
                                   box-shadow: 0 4px 18px rgba(79,70,229,0.4);">
                            <i data-lucide="log-in" class="w-4 h-4"></i> Sign In
                        </button>

                    </form>

                    <p class="text-center text-xs text-gray-400 mt-8">
                        Having trouble? Contact your administrator.
                    </p>
                </div>
            </div>

        </div>`;
}

// ==========================================
// DASHBOARD
// ==========================================
async function renderDashboard(container) {
    container.innerHTML = renderLoadingState();
    
    let kpis = {}, tasks = [], performers = [], pipeline = [], financials = {}, activities = [];
    try {
        [kpis, tasks, performers, pipeline, financials, activities] = await Promise.all([
            window.db.getDashboardKPIs(),
            window.db.getPendingTasks(), 
            window.db.getTopPerformers(),
            window.db.getPipelineHealth(),
            window.db.getFinancialStats(),
            window.db.getLiveActivity()
        ]);
    } catch (err) {
        console.error("Dashboard data error:", err);
    }

    const kData = Array.isArray(kpis) ? kpis[0] : (kpis || {});
    
    // Safety check for user names
    const safeName = (currentUser && currentUser.full_name && currentUser.full_name !== 'undefined') 
        ? currentUser.full_name.split(' ')[0] : 'there';

    // Parse KPI metrics safely
    const totalOrders = kData.total_orders || kData.totalOrders || 0;
    const dispatched = kData.dispatched_today || kData.dispatchedToday || 0;
    const inProgress = kData.in_progress || kData.inProgress || 0;
    const delayed = kData.delayed_orders || kData.delayedOrders || 0;

    const pipelineMap = {};
    (pipeline || []).forEach(p => { pipelineMap[p.step_code] = p; });

    // Render Pipeline Progress Bars
    const healthBars = stepsDirectory.map(code => {
        const s = pipelineMap[code] || { pending_count: 0, delayed_count: 0 };
        const total = (s.pending_count || 0) + (s.delayed_count || 0);
        const delayedPct = total > 0 ? (s.delayed_count / total) * 100 : 0;
        const color = stepLabels[code]?.color || '#4f46e5';
        return `
            <div class="mb-3.5">
                <div class="flex justify-between items-center text-xs mb-1.5">
                    <span class="font-semibold text-gray-700 flex items-center gap-2">
                        <span class="w-2 h-2 rounded-full" style="background:${color}"></span>${stepName(code)}
                    </span>
                    <span class="text-gray-500 font-medium">${total} active${s.delayed_count > 0 ? ` · <span class="text-red-600 font-bold">${s.delayed_count} delayed</span>` : ''}</span>
                </div>
                <div class="w-full bg-gray-100 rounded-full h-2 overflow-hidden flex">
                    <div class="h-2" style="width:${100 - delayedPct}%; background:${color}"></div>
                    <div class="h-2 bg-red-500" style="width:${delayedPct}%"></div>
                </div>
            </div>`;
    }).join('');

    // Render Top Performers List
    const medals = ['🥇', '🥈', '🥉'];
    const performerList = (performers && performers.length > 0)
        ? performers.map((p, i) => `
            <div class="flex items-center gap-3 p-2.5 hover:bg-gray-50 rounded-lg transition">
                <div class="text-xl w-6 text-center">${medals[i] || `<span class="text-xs text-gray-400 font-bold">#${i+1}</span>`}</div>
                <div class="w-9 h-9 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm" style="background:${p.avatar_color || '#4f46e5'}">
                    ${(p.full_name || 'U').substring(0,2).toUpperCase()}
                </div>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-bold text-gray-900 truncate">${p.full_name || 'Team Member'}</p>
                    <p class="text-[11px] text-gray-500">${p.on_time_pct || 0}% on-time</p>
                </div>
                <div class="text-right">
                    <p class="text-sm font-extrabold text-indigo-600">${p.total_orders || 0}</p>
                    <p class="text-[9px] text-gray-400 uppercase tracking-wider font-bold">orders</p>
                </div>
            </div>`).join('')
        : `<p class="text-sm text-gray-400 p-4 text-center">No performance data yet</p>`;

    // Render Live Activity HTML
    const activityList = activities.length > 0 ? activities.map(act => `
        <div class="relative flex gap-3 group">
            <div class="absolute left-3.5 top-8 bottom-0 w-0.5 bg-gray-100 group-last:hidden"></div>
            <div class="relative z-10 w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shadow-sm border-2 border-white" style="background:${act.users?.avatar_color || '#4f46e5'}">
                ${(act.users?.full_name || 'U').substring(0,2).toUpperCase()}
            </div>
            <div class="flex-1 pb-4">
                <p class="text-sm text-gray-800 leading-snug">
                    <span class="font-bold text-gray-900">${act.users?.full_name?.split(' ')[0] || 'Someone'}</span> 
                    completed <span class="font-semibold text-indigo-600">${stepName(act.step_code)}</span>
                </p>
                <div class="flex items-center gap-2 mt-0.5">
                    <span class="text-[10px] font-mono font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded cursor-pointer hover:bg-gray-200 transition" onclick="openOrderDrawer('${act.orders?.id}')">${act.orders?.order_code || 'Order'}</span>
                    <span class="text-[10px] text-gray-400 font-medium">${formatRelativeTime(act.submitted_at)}</span>
                </div>
            </div>
        </div>
    `).join('') : `<p class="text-sm text-gray-400 text-center italic py-4">No recent activity.</p>`;

    // Final Main Dashboard HTML injection
    container.innerHTML = `
        <div class="max-w-7xl mx-auto space-y-6 animate-in">
            <div>
                <h1 class="text-2xl font-extrabold tracking-tight">Good morning, ${safeName} 👋</h1>
                <p class="text-sm text-gray-500 mt-1">Here's what's happening with your dispatches today.</p>
            </div>

            <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
                ${kpiCard('Active Value', '₹' + formatINR(financials.pipelineRevenue || 0), 'wallet', '#8b5cf6', false)}
                ${kpiCard('Dispatched Value', '₹' + formatINR(financials.dispatchedToday || 0), 'trending-up', '#059669', false)}
                ${kpiCard(t('total_orders'), totalOrders, 'package', '#4f46e5', false)}
                ${kpiCard(t('dispatched_today'), dispatched, 'check-circle-2', '#059669', false)}
                ${kpiCard(t('in_progress'), inProgress, 'loader-2', '#2563eb', false)}
                ${kpiCard(t('delayed'), delayed, 'alert-triangle', '#dc2626', (delayed > 0))}
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <div class="lg:col-span-2 bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col max-h-[650px]">
                    <div class="p-5 border-b border-gray-100 flex justify-between items-center bg-gray-50/50 rounded-t-xl">
                        <h3 class="font-bold text-gray-900 flex items-center gap-2 text-base">
                            <i data-lucide="zap" class="w-5 h-5 text-indigo-500"></i> My Action Items
                            ${tasks && tasks.length > 0 ? `<span class="text-[10px] bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-bold">${tasks.length} PENDING</span>` : ''}
                        </h3>
                    </div>
                    <div class="divide-y divide-gray-100 flex-1 overflow-y-auto">
                        ${(tasks && tasks.length > 0) ? tasks.map(t => `
                            <div class="flex items-center justify-between p-4 hover:bg-gray-50 transition group">
                                <div class="flex items-start gap-4 cursor-pointer flex-1 min-w-0" onclick="openOrderDrawer('${t.order_id}')">
                                    <div class="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 shadow-sm ${t.is_delayed ? 'bg-red-500 text-white' : 'bg-indigo-500 text-white'}">
                                        <i data-lucide="${stepLabels[t.step_code]?.icon || 'circle'}" class="w-5 h-5"></i>
                                    </div>
                                    <div class="min-w-0">
                                        <div class="flex items-center gap-2 flex-wrap mb-1">
                                            <span class="font-mono font-bold text-[10px] text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded border border-indigo-100">${t.order_code}</span>
                                            <span class="font-extrabold text-sm text-gray-900 truncate">${t.customer_name}</span>
                                            ${t.is_delayed ? `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-red-100 text-red-700 text-[9px] font-bold rounded uppercase"><i data-lucide="clock" class="w-2.5 h-2.5"></i> ${formatDelay(t.delay_minutes)} Overdue</span>` : `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 bg-amber-50 border border-amber-200 text-amber-700 text-[9px] font-bold rounded uppercase">Upcoming</span>`}
                                        </div>
                                        <p class="text-xs text-gray-700 font-semibold truncate"><span class="text-gray-400 font-medium">Pending Action:</span> ${stepName(t.step_code)}</p>
                                    </div>
                                </div>
                                <div class="pl-4 flex-shrink-0">
                                    <button onclick="event.stopPropagation(); openStepModal('${t.order_id}', '${t.step_code}', '')" class="opacity-0 md:group-hover:opacity-100 transition-opacity bg-indigo-600 hover:bg-indigo-700 text-white text-[11px] font-bold px-4 py-2 rounded-lg shadow-md flex items-center gap-1.5 hover:-translate-y-0.5 transform">
                                        Perform Task <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
                                    </button>
                                </div>
                            </div>`).join('') : `
                            <div class="p-8 text-center text-gray-400 flex flex-col items-center">
                                <i data-lucide="check-circle-2" class="w-12 h-12 text-emerald-400 mb-3"></i>
                                <p class="font-semibold">No pending actions. Inbox zero!</p>
                            </div>`}
                    </div>
                </div>

                <div class="space-y-6">
                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                        <h3 class="font-bold text-gray-900 mb-4 flex items-center gap-2 text-base">
                            <i data-lucide="activity" class="w-4 h-4 text-indigo-500"></i> ${t('pipeline_health')}
                        </h3>${healthBars}
                    </div>

                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                        <h3 class="font-bold text-gray-900 mb-4 flex items-center gap-2 text-base">
                            <i data-lucide="award" class="w-4 h-4 text-yellow-500"></i> ${t('top_performers')}
                        </h3>
                        <div class="space-y-1">${performerList}</div>
                    </div>

                    <div class="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-[320px]">
                        <div class="p-4 border-b border-gray-100">
                            <h3 class="font-bold text-gray-900 flex items-center gap-2 text-base">
                                <i data-lucide="radio" class="w-4 h-4 text-pink-500 animate-pulse"></i> Live Activity
                            </h3>
                        </div>
                        <div class="p-5 pt-3 flex-1 overflow-y-auto">
                            ${activityList}
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    lucide.createIcons();
}

function kpiCard(label, value, icon, color, urgent) {
    const bgClass = urgent ? 'bg-red-50 border-red-200' : 'bg-white border-gray-200';
    return `
        <div class="${bgClass} p-5 rounded-xl shadow-sm border card-hover">
            <div class="flex items-start justify-between mb-3">
                <div class="kpi-icon" style="background:${color}15;">
                    <i data-lucide="${icon}" class="w-5 h-5" style="color:${color}"></i>
                </div>
                ${urgent && value > 0 ? `<span class="text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded animate-pulse">URGENT</span>` : ''}
            </div>
            <div class="text-[11px] text-gray-500 font-semibold uppercase tracking-wider">${label}</div>
            <div class="text-xl font-extrabold mt-1 tracking-tight leading-tight break-all ${urgent && value > 0 ? 'text-red-600' : ''}">${value}</div>
        </div>`;
}

// ==========================================
// KANBAN
// ==========================================
async function renderKanban(container) {
    container.innerHTML = renderLoadingState();
    const tasks = (await window.db.getKanbanTasks()) || [];

    let columnsHtml = '';
    stepsDirectory.forEach((stepCode) => {
        const stepTasks = tasks.filter(t => t.step_code === stepCode && t.status !== 'DONE');
        const color = stepLabels[stepCode]?.color || '#4f46e5';
        columnsHtml += `
            <div class="flex flex-col flex-shrink-0 w-80 bg-gray-50 rounded-xl border border-gray-200 shadow-sm max-h-[80vh]">
                <div class="p-3.5 border-b border-gray-200 bg-white rounded-t-xl flex justify-between items-center sticky top-0 z-10">
                    <span class="flex items-center gap-2 font-bold text-gray-800 text-sm truncate pr-2">
                        <span class="w-2.5 h-2.5 rounded-full flex-shrink-0" style="background:${color}"></span>${stepName(stepCode)}
                    </span>
                    <span class="bg-indigo-100 text-indigo-700 px-2.5 py-0.5 rounded-full text-xs font-black shadow-sm flex-shrink-0">${stepTasks.length}</span>
                </div>
                <div class="p-3 flex-1 overflow-y-auto kanban-col space-y-3" data-step="${stepCode}">
                    ${stepTasks.map(task => `
                        <div class="kanban-card bg-white border border-gray-200 p-3.5 rounded-xl shadow-sm" data-order-id="${task.order_id}" onclick="openOrderDrawer('${task.order_id}')">
                            <div class="flex justify-between items-start mb-2">
                                <span class="font-mono text-xs font-black text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">${task.order_code}</span>
                                ${task.is_delayed ? `<span class="px-1.5 py-0.5 bg-red-100 text-red-700 rounded text-[10px] font-bold">⚠ DELAYED</span>` : ''}
                            </div>
                            <p class="text-sm font-bold text-gray-900 truncate mb-2" title="${task.customer_name}">${task.customer_name}</p>
                            <div class="flex justify-between items-center border-t border-gray-50 pt-2 mt-1">
                                <div class="flex items-center gap-1 text-[11px] font-semibold ${task.is_delayed ? 'text-red-600' : 'text-gray-500'}">
                                    <i data-lucide="calendar" class="w-3 h-3"></i>${task.due_date ? new Date(task.due_date).toLocaleDateString(undefined, {month:'short', day:'numeric'}) : '—'}
                                </div>
                                <button onclick="event.stopPropagation(); openOrderDrawer('${task.order_id}')" class="text-[10px] font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-2 py-1 rounded transition">OPEN</button>
                            </div>
                        </div>`).join('')}
                </div>
            </div>`;
    });

    container.innerHTML = `
        <div class="h-full flex flex-col">
            <div class="mb-5">
                <h2 class="text-2xl font-extrabold tracking-tight">${t('kanban')}</h2>
                <p class="text-sm text-gray-500 mt-1">Click any card to open detailed action drawer · Real-time sync</p>
            </div>
            <div class="flex flex-1 gap-4 overflow-x-auto pb-4 items-start">${columnsHtml}</div>
        </div>`;

    document.querySelectorAll('.kanban-col').forEach(col => {
        new Sortable(col, {
            group: 'shared', animation: 200, ghostClass: 'sortable-ghost', dragClass: 'sortable-drag',
            onEnd: function (evt) {
                const orderId = evt.item.getAttribute('data-order-id');
                const oldStep = evt.from.getAttribute('data-step');
                const newStep = evt.to.getAttribute('data-step');
                if (newStep !== oldStep) {
                    evt.from.appendChild(evt.item);
                    openOrderDrawer(orderId);
                }
            },
        });
    });
}

// ==========================================
// ORDERS LIST
// ==========================================
async function renderOrders(container) {
    container.innerHTML = renderLoadingState();
    const orders = (await window.db.getOrders()) || [];
    window.__allOrders = orders;
    window.__orderFilters = { status: 'all', step: 'all', salesPerson: 'all', search: '', type: 'all', dateFrom: '', dateTo: '' };

    container.innerHTML = `
        <div class="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-col h-full max-h-[85vh]">
            <div class="p-5 border-b border-gray-200 bg-gray-50/50 rounded-t-xl">
                <h2 class="font-bold text-lg text-gray-900">${t('orders')} <span class="ml-2 text-sm text-gray-500 font-medium">(${orders.length})</span></h2>
            </div>
            ${renderOrderFilters(orders)}
            <div class="overflow-auto flex-1">
                ${orders.length === 0 ? `
                    <div class="p-12 text-center text-gray-400">
                        <i data-lucide="package" class="w-12 h-12 mx-auto mb-3"></i>
                        <p class="font-semibold">No orders yet</p>
                        <a href="#/orders/new" class="inline-block mt-4 text-indigo-600 font-bold hover:underline">Create your first order →</a>
                    </div>
                ` : `
                <table class="w-full text-left text-sm whitespace-nowrap">
                    <thead class="bg-white text-gray-500 sticky top-0 z-10 border-b border-gray-200 shadow-sm">
                        <tr>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">${t('order_code')}</th>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">${t('customer')}</th>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">Value</th>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">Dispatch Mode</th>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">Sales Person</th>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">Current Step</th>
                            <th class="px-6 py-3 uppercase tracking-wider text-[11px] font-bold">${t('status')}</th>
                        </tr>
                    </thead>
                    <tbody id="orders-tbody" class="divide-y divide-gray-100"></tbody>
                </table>
                `}
            </div>
        </div>`;
    renderOrderRows(orders);
    lucide.createIcons();
}

// ==========================================
// NEW ORDER FORM
// ==========================================
async function renderNewOrder(container) {
    container.innerHTML = renderLoadingState();
    const salesUsers = await window.db.getSalesUsers();
    container.innerHTML = `
        <div class="max-w-3xl mx-auto animate-in">
            <button onclick="history.back()" class="text-sm font-semibold text-gray-500 hover:text-gray-900 mb-6 flex items-center gap-1">
                <i data-lucide="arrow-left" class="w-4 h-4"></i> Back
            </button>
            <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
                <div class="p-6 border-b border-gray-100 bg-gray-50/50">
                    <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Create New Order (OR1)</h2>
                    <p class="text-sm text-gray-500 mt-1">Order code is generated automatically once submitted.</p>
                </div>
                <form onsubmit="handleCreateOrder(event)" class="p-8 space-y-6">
                    <div class="grid grid-cols-2 gap-6">
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Customer Name *</label>
                            <input type="text" id="no_customer_name" required placeholder="Company / customer name..." autocomplete="off"
                                   class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                        </div>
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Contact Person</label>
                            <input type="text" id="no_contact_person" placeholder="e.g. Shreya" class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                        </div>
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Customer Phone</label>
                            <input type="tel" id="no_phone" placeholder="9876543210" class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                        </div>
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">City</label>
                            <input type="text" id="no_city" placeholder="e.g. Delhi" class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                        </div>
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Payment Type *</label>
                            <select id="no_payment_type" required class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                                <option value="ADVANCE">ADVANCE</option>
                                <option value="CREDIT">CREDIT</option>
                            </select>
                        </div>
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Dispatch Mode *</label>
                            <select id="no_mode" required class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                                <option value="PORTER">PORTER</option>
                                <option value="TEMPO">TEMPO</option>
                                <option value="RICKSHAW">RICKSHAW</option>
                            </select>
                        </div>
                        <div class="col-span-2 md:col-span-1">
                            <label class="block text-sm font-semibold text-gray-700 mb-2">Sales Person *</label>
                            <select id="no_sales" required onchange="handleSalesChange(this)" class="w-full border border-gray-300 rounded-lg p-2.5 focus:ring-2 focus:ring-indigo-500 outline-none">
                                <option value="" disabled selected>Assign sales...</option>
                                ${(salesUsers || []).map(u => `<option value="${escapeHtml(u.full_name)}">${escapeHtml(u.full_name)}</option>`).join('')}
                                <option value="__OTHER__">+ Others (type name)</option>
                            </select>
                            <input type="text" id="no_sales_custom" placeholder="Enter sales person name..." style="display:none;" class="w-full border border-gray-300 rounded-lg p-2.5 mt-2 focus:ring-2 focus:ring-indigo-500 outline-none">
                        </div>
                    </div>
                    <div class="pt-6 border-t border-gray-100 flex justify-end gap-3">
                        <button type="button" onclick="history.back()" class="px-5 py-2.5 text-sm font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 rounded-lg transition">${t('cancel')}</button>
                        <button type="submit" id="no_submit_btn" class="px-5 py-2.5 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-md flex items-center gap-2">
                            <i data-lucide="check" class="w-4 h-4"></i> ${t('create_order')}
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
}

// ==========================================
// 🎯 ORDER DETAIL DRAWER
// ==========================================
window.openOrderDrawer = async function(orderId) {
    const order = await window.db.getOrderDetail(orderId);
    if (!order) return showToast('Order not found', 'error');
    
    // Always render drawer at body level — escapes any parent layout issues
    let root = document.getElementById('drawer-root-body');
    if (!root) {
        document.body.insertAdjacentHTML('beforeend', '<div id="drawer-root-body"></div>');
        root = document.getElementById('drawer-root-body');
    }

    root.innerHTML = `
        <div id="drawer-overlay" class="drawer-overlay" onclick="closeOrderDrawer()"></div>
        <aside id="order-drawer" data-order-id="${orderId}" class="drawer-panel">
            <div class="flex justify-center items-center h-full">
                <div class="spinner"></div>
            </div>
        </aside>`;

    requestAnimationFrame(() => {
        document.getElementById('drawer-overlay')?.classList.add('open');
        document.getElementById('order-drawer')?.classList.add('open');
    });

    try {
        const { order, steps } = await window.db.getOrderDetail(orderId);
        if (!order) {
            document.getElementById('order-drawer').innerHTML = `<div class="p-8 text-center text-red-500 font-bold">Order not found</div>`;
            return;
        }

        if (!steps || steps.length === 0) {
            console.warn('No step rows returned for order ' + orderId);
        }

        const stepsSorted = (steps || []).slice().sort((a, b) => {
            return stepsDirectory.indexOf(a.step_code) - stepsDirectory.indexOf(b.step_code);
        });

        const nextStep = stepsSorted.find(s => s.status !== 'DONE' && s.status !== 'SKIPPED');
        const submissions = await window.db.getOrderSubmissions(orderId);
        const subMap = {};
        (submissions || []).forEach(s => { if (s.is_latest) subMap[s.step_code] = s; });

        document.getElementById('order-drawer').innerHTML = renderDrawerContent(order, stepsSorted, nextStep, subMap);
        lucide.createIcons();
    } catch (err) {
        console.error(err);
        document.getElementById('order-drawer').innerHTML = `<div class="p-8 text-center text-red-500">Error: ${err.message}</div>`;
    }
};

window.closeOrderDrawer = function() {
    const overlay = document.getElementById('drawer-overlay');
    const drawer = document.getElementById('order-drawer');
    if (!drawer) return;
    overlay?.classList.remove('open');
    drawer.classList.remove('open');
    setTimeout(() => {
        const drawerRoot = document.getElementById('drawer-root-body');
if (drawerRoot) drawerRoot.innerHTML = '';
    }, 300);
};

function renderDrawerContent(order, steps, nextStep, subMap) {
    const visibleSteps = steps.filter(s => {
        const cfg = stepLabels[s.step_code];
        if (cfg?.situational && s.step_code === 'STEP2_EMAIL_PRODUCTION') {
            return order.type_of_order !== 'BLANK';
        }
        return true;
    });

    const visibleNext = visibleSteps.find(s => s.status !== 'DONE' && s.status !== 'SKIPPED');

    const header = `
        <div class="drawer-header">
            <div class="flex items-start justify-between p-5 border-b border-gray-100">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 mb-1 flex-wrap">
                        <span class="font-mono text-xs font-bold text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded">${order.order_code}</span>
                        ${order.is_cancelled ? `<span class="text-[10px] font-bold text-white bg-gray-700 px-2 py-0.5 rounded uppercase">✕ Cancelled</span>` : ''}
                        ${!order.is_cancelled && order.is_delayed ? `<span class="text-[10px] font-bold text-red-700 bg-red-100 px-2 py-0.5 rounded uppercase">⚠ Delayed</span>` : ''}
                        ${!order.is_cancelled && order.is_completed ? `<span class="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded uppercase">✓ Completed</span>` : ''}
                        ${order.type_of_order ? `<span class="text-[10px] font-bold text-gray-700 bg-gray-100 px-2 py-0.5 rounded uppercase">${order.type_of_order}</span>` : ''}
                    </div>
                    <h2 class="text-xl font-extrabold text-gray-900 truncate" title="${order.customer_name}">${order.customer_name}</h2>
                    <p class="text-xs text-gray-500 mt-0.5">${order.customer_phone || ''}</p>
                </div>
                <div class="flex items-center gap-1">
                    ${!order.is_cancelled && !order.is_completed ? `
                        <button onclick="cancelOrderConfirm('${order.id}', '${order.order_code}')" title="Cancel order" class="text-gray-400 hover:text-red-600 transition p-1.5 hover:bg-red-50 rounded-full">
                            <i data-lucide="ban" class="w-4 h-4"></i>
                        </button>
                    ` : ''}
                    <button onclick="closeOrderDrawer()" class="text-gray-400 hover:text-gray-900 transition p-1.5 hover:bg-gray-100 rounded-full">
                        <i data-lucide="x" class="w-5 h-5"></i>
                    </button>
                </div>
            </div>
        </div>`;

    const summaryCard = `
        <div class="p-5 space-y-3">
            <div class="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600/70 uppercase tracking-wider">Order Value</div>
                        <div class="text-lg font-extrabold text-gray-900 font-mono mt-0.5">₹${formatINR(order.order_value)}</div>
                    </div>
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600/70 uppercase tracking-wider">Order Date</div>
                        <div class="text-sm font-bold text-gray-900 mt-1">${order.order_date ? new Date(order.order_date).toLocaleDateString() : '—'}</div>
                    </div>
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600/70 uppercase tracking-wider">Sales Person</div>
                        <div class="text-sm font-bold text-gray-900 mt-1">${order.sales_person_name || '—'}</div>
                    </div>
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600/70 uppercase tracking-wider flex items-center justify-between">
                            <span>Dispatch Mode</span>
                            <button onclick="editDispatchMode('${order.id}', '${order.dispatch_mode || ''}')" class="text-indigo-600 hover:text-indigo-800 normal-case font-bold text-[10px]">
                                <i data-lucide="edit-2" class="w-3 h-3 inline"></i> Edit
                            </button>
                        </div>
                        <div class="text-sm font-bold text-gray-900 mt-1" id="dispatch-mode-display">${order.dispatch_mode || '—'}</div>
                    </div>
                </div>
            </div>
        </div>`;

    let nextActionCard = '';
    if (visibleNext && !order.is_completed && !order.is_cancelled) {
        const isOverdue = visibleNext.status === 'DELAYED';
        nextActionCard = `
            <div class="mx-5 mb-4 rounded-xl p-4 border-2 ${isOverdue ? 'bg-red-50 border-red-300 text-red-900' : 'bg-indigo-600 border-indigo-700 text-white'}">
                <div class="flex items-start justify-between gap-3">
                    <div class="flex-1 min-w-0">
                        <div class="text-[10px] font-bold uppercase tracking-wider mb-1 ${isOverdue ? 'text-red-700' : 'text-indigo-200'}">
                            ${isOverdue ? '🚨 Action Overdue' : '⚡ Next Action Required'}
                        </div>
                        <div class="font-extrabold text-sm">${stepName(visibleNext.step_code)}</div>
                        ${visibleNext.planned_at ? `<div class="text-[11px] mt-0.5 ${isOverdue ? 'text-red-700' : 'text-indigo-200'}">Planned: ${new Date(visibleNext.planned_at).toLocaleString()}</div>` : ''}
                    </div>
                    <button onclick="openStepModal('${order.id}', '${visibleNext.step_code}', '${order.type_of_order || ''}')"
                            class="bg-white ${isOverdue ? 'text-red-700' : 'text-indigo-700'} font-bold text-xs px-4 py-2 rounded-lg hover:bg-gray-100 shadow flex items-center gap-1.5 flex-shrink-0">
                        <i data-lucide="${stepLabels[visibleNext.step_code]?.needsEvidence ? 'upload' : 'edit-3'}" class="w-3.5 h-3.5"></i>
                        ${stepLabels[visibleNext.step_code]?.needsEvidence ? 'Upload Evidence' : 'Update Info'}
                    </button>
                </div>
            </div>`;
    }

    if (order.is_cancelled) {
        nextActionCard = `
            <div class="mx-5 mb-4 rounded-xl p-4 border-2 bg-gray-100 border-gray-300">
                <div class="flex items-start gap-3">
                    <i data-lucide="ban" class="w-8 h-8 text-gray-600 flex-shrink-0"></i>
                    <div class="flex-1 min-w-0">
                        <div class="font-extrabold text-gray-800">Order Cancelled</div>
                        ${order.cancelled_at ? `<div class="text-[11px] text-gray-500 mt-0.5">${new Date(order.cancelled_at).toLocaleString()}</div>` : ''}
                        ${order.cancellation_reason ? `<div class="text-xs text-gray-700 mt-2 bg-white border border-gray-200 rounded-lg p-2 italic">"${escapeHtml(order.cancellation_reason)}"</div>` : ''}
                        <button onclick="restoreOrderConfirm('${order.id}')" class="mt-3 text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-md flex items-center gap-1.5 transition">
                            <i data-lucide="rotate-ccw" class="w-3 h-3"></i> Restore Order
                        </button>
                    </div>
                </div>
            </div>`;
    } else if (order.is_completed) {
        nextActionCard = `
            <div class="mx-5 mb-4 rounded-xl p-4 border-2 bg-emerald-50 border-emerald-300 text-emerald-900">
                <div class="flex items-center gap-3">
                    <i data-lucide="check-circle-2" class="w-8 h-8 text-emerald-600"></i>
                    <div>
                        <div class="font-extrabold">Order Fully Dispatched! 🎉</div>
                        <div class="text-xs text-emerald-700 mt-0.5">All steps completed successfully</div>
                    </div>
                </div>
            </div>`;
    }

    const intakeCard = order.delivery_challan_file ? `
        <div class="px-5 pb-3">
            <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Stage 1 · Order Intake</div>
            <div class="bg-emerald-50 border border-emerald-200 rounded-xl p-3 flex items-center gap-3">
                <div class="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center flex-shrink-0">
                    <i data-lucide="check" class="w-4 h-4 text-white"></i>
                </div>
                <div class="flex-1 min-w-0">
                    <div class="font-bold text-sm text-gray-900">Order Created</div>
                    <div class="text-[11px] text-emerald-700 mt-0.5">${order.order_date ? new Date(order.order_date).toLocaleString() : ''}</div>
                </div>
                <button onclick="previewFile('${order.delivery_challan_file}', 'Delivery Challan — ${order.order_code}')" class="text-xs text-indigo-600 hover:underline font-semibold flex items-center gap-1">
    <i data-lucide="eye" class="w-3 h-3"></i> View Challan
</button>
            </div>
        </div>` : '';

    const stepsTimeline = `
        <div class="px-5 pb-5 space-y-3">
            <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Workflow Steps</div>
            ${visibleSteps.map(s => renderDrawerStep(s, order, subMap[s.step_code])).join('')}
        </div>`;

    const shareCard = order.is_cancelled ? '' : `
        <div class="mx-5 mb-4 bg-gradient-to-br from-violet-50 to-pink-50 rounded-xl p-4 border border-violet-100">
            <div class="flex items-center justify-between gap-3">
                <div class="flex items-center gap-2.5 min-w-0">
                    <div class="w-9 h-9 bg-white rounded-lg flex items-center justify-center flex-shrink-0">
                        <i data-lucide="share-2" class="w-4 h-4 text-violet-600"></i>
                    </div>
                    <div class="min-w-0">
                        <div class="font-bold text-sm text-gray-900">Share with Customer</div>
                        <div class="text-[11px] text-gray-500">Generate a public tracking link</div>
                    </div>
                </div>
                <button onclick="generateShareLink('${order.id}', '${order.order_code}', '${(order.customer_phone || '').replace(/[^0-9]/g,'')}')"
                        class="bg-violet-600 hover:bg-violet-700 text-white text-xs font-bold px-3 py-2 rounded-lg shadow flex items-center gap-1.5 flex-shrink-0">
                    <i data-lucide="link" class="w-3.5 h-3.5"></i> Share
                </button>
            </div>
        </div>`;

    return `${header}<div class="drawer-body">${summaryCard}${nextActionCard}${shareCard}${intakeCard}${stepsTimeline}</div>`;
}

function renderDrawerStep(step, order, latestSub) {
    const code = step.step_code;
    const cfg = stepLabels[code] || {};
    const orderId = order.id;
    const isDone = step.status === 'DONE';
    const isDelayed = step.status === 'DELAYED';
    const color = cfg.color || '#4f46e5';
    const icon = cfg.icon || 'circle';
    const stepNumber = code.match(/STEP(\d)/)?.[1] || '?';

    let statusBadge = '';
    if (isDone) statusBadge = `<span class="text-[10px] font-bold text-emerald-700 flex items-center gap-1"><i data-lucide="check" class="w-3 h-3"></i> Done</span>`;
    else if (isDelayed) statusBadge = `<span class="text-[10px] font-bold text-red-700">⚠ Overdue</span>`;
    else statusBadge = `<span class="text-[10px] font-bold text-amber-600">⏳ Pending</span>`;

    const hintBlock = cfg.hint_en ? `
        <div class="ml-12 mt-2 mb-2 px-3 py-2 bg-indigo-50/50 border-l-2 border-indigo-300 rounded-r text-[11px] text-gray-700 italic leading-relaxed">
            💡 ${stepHint(code)}
        </div>` : '';

    const planned = step.planned_at ? new Date(step.planned_at) : null;
    const actual = step.actual_at ? new Date(step.actual_at) : null;
    let delayMins = step.delay_minutes || 0;
    if (!actual && planned && planned < new Date()) {
        delayMins = Math.floor((Date.now() - planned.getTime()) / 60000);
    }

    const metricsRow = `
        <div class="ml-12 mt-2 grid grid-cols-3 gap-2 text-[10px]">
            <div class="bg-gray-50 rounded p-1.5">
                <div class="text-gray-400 font-bold uppercase tracking-wider mb-0.5">Planned</div>
                <div class="font-semibold text-gray-700">${planned ? planned.toLocaleString(undefined, { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}</div>
            </div>
            <div class="bg-gray-50 rounded p-1.5">
                <div class="text-gray-400 font-bold uppercase tracking-wider mb-0.5">Actual</div>
                <div class="font-semibold text-gray-700">${actual ? actual.toLocaleString(undefined, { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' }) : '—'}</div>
            </div>
            <div class="${delayMins > 0 ? 'bg-red-50' : 'bg-emerald-50'} rounded p-1.5">
                <div class="${delayMins > 0 ? 'text-red-500' : 'text-emerald-500'} font-bold uppercase tracking-wider mb-0.5">Delay</div>
                <div class="font-semibold ${delayMins > 0 ? 'text-red-700' : 'text-emerald-700'}">${delayMins > 0 ? formatDelay(delayMins) : '✓ On time'}</div>
            </div>
        </div>`;

    // BMH's forms are generic (proof file + notes for every step), so the
    // preview is just the notes text if any was entered — no per-step
    // custom fields like MMC's lead_time/PDI-checklist/charges_amount/tracking_id.
    let dataPreview = '';
    if (isDone && latestSub?.form_data?.notes) {
        dataPreview = `<div class="ml-12 mt-2 text-[11px] text-gray-700 bg-gray-50 p-2 rounded border-l-2 border-gray-300 italic">
            📝 ${escapeHtml(latestSub.form_data.notes)}
        </div>`;
    }

    // ─── File row (auto-detects ALL files in form_data) ───
    let fileRow = '';
    if (isDone && latestSub?.form_data) {
        const fd = latestSub.form_data;
        const files = [];
        
        // Detect ALL file URLs in form_data (any key ending with _url)
        Object.keys(fd).forEach(key => {
            if (key.endsWith('_url') && fd[key] && typeof fd[key] === 'string') {
                // Human-friendly label from the key
                const labelMap = {
                    'file_url':     { label: 'Evidence',     icon: 'paperclip', color: 'indigo' },
                    'video_url':    { label: 'Video',        icon: 'video',     color: 'purple' },
                    'gatepass_url': { label: 'Gate Pass',    icon: 'ticket',    color: 'amber'  },
                    'photo_url':    { label: 'Photo',        icon: 'image',     color: 'pink'   },
                    'invoice_url':  { label: 'Invoice',      icon: 'file-text', color: 'green'  },
                    'receipt_url':  { label: 'Receipt',      icon: 'receipt',   color: 'cyan'   }
                };
                const info = labelMap[key] || { 
                    label: key.replace('_url','').replace(/_/g,' ').replace(/\b\w/g, c => c.toUpperCase()), 
                    icon: 'file', 
                    color: 'gray' 
                };
                files.push({ url: fd[key], ...info });
            }
        });

        if (files.length > 0) {
            const colorClasses = {
                indigo: 'text-indigo-600 bg-indigo-50 hover:bg-indigo-100',
                purple: 'text-purple-600 bg-purple-50 hover:bg-purple-100',
                amber:  'text-amber-700 bg-amber-50 hover:bg-amber-100',
                pink:   'text-pink-600 bg-pink-50 hover:bg-pink-100',
                green:  'text-green-700 bg-green-50 hover:bg-green-100',
                cyan:   'text-cyan-700 bg-cyan-50 hover:bg-cyan-100',
                gray:   'text-gray-600 bg-gray-50 hover:bg-gray-100'
            };
            
            fileRow = `<div class="ml-12 mt-2 flex flex-wrap gap-1.5">
                ${files.map(f => `
                    <button onclick="previewFile('${f.url}', '${escapeHtml(f.label)} — ${stepName(code)}')" 
                            class="inline-flex items-center gap-1.5 text-xs font-semibold ${colorClasses[f.color]} px-2 py-1 rounded transition">
                        <i data-lucide="${f.icon}" class="w-3 h-3"></i> ${f.label}
                    </button>
                `).join('')}
            </div>`;
        }
    }

    const btnIcon = cfg.needsEvidence ? 'upload' : 'edit-3';
    const btnLabel = isDone ? (cfg.needsEvidence ? 'Replace' : 'Update') : (cfg.needsEvidence ? 'Upload Evidence' : 'Submit Info');
    const actionBtn = isDone
        ? `<button onclick="openStepModal('${orderId}', '${code}', '${order.type_of_order || ''}')" class="text-xs font-bold text-gray-600 bg-white border border-gray-300 hover:bg-gray-50 px-2.5 py-1 rounded-md flex items-center gap-1 transition">
              <i data-lucide="refresh-cw" class="w-3 h-3"></i> ${btnLabel}
          </button>`
        : `<button onclick="openStepModal('${orderId}', '${code}', '${order.type_of_order || ''}')" class="text-xs font-bold text-white bg-indigo-600 hover:bg-indigo-700 px-3 py-1.5 rounded-md flex items-center gap-1 transition shadow">
              <i data-lucide="${btnIcon}" class="w-3 h-3"></i> ${btnLabel}
          </button>`;

    return `
        <div class="bg-white border ${isDelayed ? 'border-red-300 bg-red-50/30' : 'border-gray-200'} rounded-xl p-3 transition hover:shadow-sm">
            <div class="flex items-center justify-between">
                <div class="flex items-center gap-3 flex-1 min-w-0">
                    <div class="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${isDone ? 'bg-emerald-500' : ''}" style="${!isDone ? `background:${color}` : ''}">
                        ${isDone
                            ? `<i data-lucide="check" class="w-4 h-4 text-white"></i>`
                            : `<i data-lucide="${icon}" class="w-4 h-4 text-white"></i>`}
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                            <span class="font-bold text-sm text-gray-900">${stepName(code)}</span>
                            ${statusBadge}
                        </div>
                        <div class="text-[10px] text-gray-400 font-mono mt-0.5">Stage ${stepNumber}</div>
                    </div>
                </div>
                <div class="flex-shrink-0">${actionBtn}</div>
            </div>
            ${hintBlock}
            ${metricsRow}
            ${dataPreview}
            ${fileRow}
        </div>`;
}

window.openStepModal = function(orderId, stepCode) {
    let container = document.getElementById('step-modal-container');
    if (!container) {
        document.body.insertAdjacentHTML('beforeend', '<div id="step-modal-container"></div>');
        container = document.getElementById('step-modal-container');
    }

    const cfg = stepLabels[stepCode] || {};
    const bucket = 'bmh-proofs';   // single bucket for every step, per schema.sql

    const fields = `
        <div class="bg-indigo-50 border border-indigo-100 rounded-lg p-3 mb-4 text-xs text-indigo-900 leading-relaxed">
            💡 ${stepHint(stepCode)}
        </div>
        <label class="block text-sm font-semibold text-gray-700 mb-1">Proof File *</label>
        <input type="file" id="form-file" accept="image/*,.pdf" required class="w-full border rounded-lg p-2 text-sm bg-gray-50 mb-3">
        <label class="block text-sm font-semibold text-gray-700 mb-1">Notes (optional)</label>
        <textarea id="form-notes" placeholder="Any notes for this step..." class="w-full border rounded-lg p-2 text-sm h-20"></textarea>`;

    container.innerHTML = `
        <div id="step-modal" class="fixed inset-0 z-[60] flex items-center justify-center modal-backdrop p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-hidden border border-gray-100 flex flex-col">
                <div class="p-5 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center flex-shrink-0">
                    <div>
                        <h3 class="font-black text-lg text-gray-900 tracking-tight">Submit Evidence</h3>
                        <p class="text-xs font-bold text-indigo-600 mt-0.5">${stepName(stepCode)}</p>
                    </div>
                    <button onclick="closeModal()" class="text-gray-400 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-full p-1.5 transition">
                        <i data-lucide="x" class="w-5 h-5"></i>
                    </button>
                </div>
                <form onsubmit="submitStepForm(event, '${orderId}', '${stepCode}', '${bucket}')" class="p-6 overflow-y-auto flex-1">
                    ${fields}
                    <div class="mt-6 flex justify-end gap-3 sticky bottom-0 bg-white pt-3 border-t border-gray-100">
                        <button type="button" onclick="closeModal()" class="px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 rounded-lg transition">${t('cancel')}</button>
                        <button type="submit" id="step_submit_btn" class="px-5 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-md flex items-center gap-2">
                            <i data-lucide="check-circle" class="w-4 h-4"></i> Submit
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
    lucide.createIcons();
};

window.closeModal = function() {
    document.getElementById('step-modal')?.remove();
};

window.submitStepForm = async function(e, orderId, stepCode, bucket) {
    e.preventDefault();
    const btn = document.getElementById('step_submit_btn');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Processing...`;
    lucide.createIcons();

    try {
        const formData = {
            submitted_at: new Date().toISOString(),
            submitted_by: currentUser.id
        };

        const notes = document.getElementById('form-notes')?.value;
        if (notes) formData.notes = notes;

        const fileInput = document.getElementById('form-file');
        if (fileInput && fileInput.files.length > 0) {
            formData.file_url = await window.db.uploadFile(bucket, fileInput.files[0]);
        }

        await window.db.submitStep(orderId, stepCode, formData);
        closeModal();
        showToast(t('step_completed') || 'Step completed!', 'success');
        openOrderDrawer(orderId);
        if (['#/orders', '#/dashboard', '#/board'].includes(location.hash)) router();
    } catch (err) {
        console.error(err);
        showToast(err.message || 'Error', 'error');
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="check-circle" class="w-4 h-4"></i> Submit`;
        lucide.createIcons();
    }
};

// ==========================================
// AUTH + ACTIONS
// ==========================================
window.handleLogin = async function(e) {
    e.preventDefault();
    const btn = document.getElementById('login_btn');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Signing in...`;
    lucide.createIcons();
    try {
        const email = document.getElementById('email').value;
        const password = document.getElementById('password').value;
        const { error } = await window.db.login(email, password);
        if (error) throw error;
        
        // Auto-detect mobile vs desktop (multiple checks)
        const isMobileUA = /Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const isMobileWidth = window.innerWidth < 768;
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
        const isMobile = isMobileUA || isMobileWidth || (isTouchDevice && window.innerWidth < 1024);
        location.hash = isMobile ? '#/mobile/orders' : '#/dashboard';
        window.location.reload();
        
    } catch (err) {
        showToast(err.message || 'Login failed', 'error');
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="log-in" class="w-4 h-4"></i> Sign In`;
        lucide.createIcons();
    }
};

window.handleLogout = async function() {
    await window.db.logout();
    location.hash = '#/login';
    window.location.reload();
};

window.toggleLanguage = function() {
    const current = localStorage.getItem('mmc_lang') || 'en';
    localStorage.setItem('mmc_lang', current === 'en' ? 'hi' : 'en');
    router();
};

window.handleCreateOrder = async function(e) {
    e.preventDefault();
    const btn = document.getElementById('no_submit_btn');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin inline"></i> Creating...`;
    lucide.createIcons();
    try {
        const salesEl = document.getElementById('no_sales');
        const customerNameInput = document.getElementById('no_customer_name').value.trim();
        const customerPhoneInput = document.getElementById('no_phone').value.trim() || null;

        // order_code/order_number are generated server-side by the create_order RPC
        const customerId = await window.db.upsertCustomer(currentOrgId, customerNameInput, customerPhoneInput);

        const newOrder = await window.db.createOrder({
            organizationId: currentOrgId,
            customerId: customerId,
            customerName: customerNameInput,
            customerPhone: customerPhoneInput,
            contactPerson: document.getElementById('no_contact_person').value.trim() || null,
            city: document.getElementById('no_city').value.trim() || null,
            paymentType: document.getElementById('no_payment_type').value,
            dispatchMode: document.getElementById('no_mode').value,
            salesPersonName: salesEl.value === '__OTHER__'
                ? document.getElementById('no_sales_custom').value.trim()
                : salesEl.value,
            orderValue: null   // BMH's process doesn't track this — schema column stays nullable
        });
        showToast('Order created!', 'success');
        location.hash = '#/orders';
        setTimeout(() => openOrderDrawer(newOrder.id), 400);
    } catch (err) {
        console.error(err);
        showToast(err.message, 'error');
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> ${t('create_order')}`;
        lucide.createIcons();
    }
};

window.addQuickCustomer = async function(e) {
    if (e) e.preventDefault();
    const name = prompt('Customer name:');
    if (!name?.trim()) return;
    try {
        await window.db.supabase.from('customers').insert([{ organization_id: currentOrgId, name: name.trim() }]);
        showToast('Customer added!', 'success');
        setTimeout(() => router(), 600);
    } catch (err) { showToast(err.message, 'error'); }
};

// ==========================================
// 🚫 CANCEL ORDER
// ==========================================
window.cancelOrderConfirm = function(orderId, orderCode) {
    const html = `
        <div id="cancel-modal" class="fixed inset-0 z-[70] flex items-center justify-center modal-backdrop p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border border-gray-100">
                <div class="bg-gradient-to-br from-red-500 to-rose-600 p-5 text-white">
                    <div class="flex items-start gap-3">
                        <div class="w-10 h-10 bg-white/20 rounded-full flex items-center justify-center flex-shrink-0">
                            <i data-lucide="ban" class="w-5 h-5"></i>
                        </div>
                        <div class="flex-1">
                            <h3 class="font-extrabold text-lg">Cancel Order?</h3>
                            <p class="text-xs text-white/90 mt-0.5">Order <span class="font-mono font-bold">${orderCode}</span> will be marked as cancelled</p>
                        </div>
                        <button onclick="document.getElementById('cancel-modal').remove()" class="text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-1.5">
                            <i data-lucide="x" class="w-4 h-4"></i>
                        </button>
                    </div>
                </div>
                <form onsubmit="submitCancelOrder(event, '${orderId}')" class="p-5 space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-700 uppercase tracking-wider mb-2">Reason for cancellation *</label>
                        <select id="cancel-reason-preset" onchange="document.getElementById('cancel-reason').value = this.value === 'OTHER' ? '' : this.value; document.getElementById('cancel-reason').focus();" class="w-full border border-gray-300 rounded-lg p-2.5 text-sm mb-2">
                            <option value="" disabled selected>Select reason...</option>
                            <option value="Customer requested cancellation">Customer requested cancellation</option>
                            <option value="Out of stock — cannot fulfill">Out of stock — cannot fulfill</option>
                            <option value="Payment issue / Not received">Payment issue / Not received</option>
                            <option value="Duplicate order">Duplicate order</option>
                            <option value="Wrong order details">Wrong order details</option>
                            <option value="Quality / Production issue">Quality / Production issue</option>
                            <option value="Customer unreachable">Customer unreachable</option>
                            <option value="OTHER">Other (type below)</option>
                        </select>
                        <textarea id="cancel-reason" required rows="3" placeholder="Additional details (optional)..." class="w-full border border-gray-300 rounded-lg p-2.5 text-sm resize-none"></textarea>
                    </div>
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex gap-2">
                        <i data-lucide="alert-triangle" class="w-4 h-4 flex-shrink-0 mt-0.5"></i>
                        <span>The order will move to <strong>Cancelled</strong> status. You can restore it later if needed.</span>
                    </div>
                    <div class="flex justify-end gap-2 pt-2 border-t border-gray-100">
                        <button type="button" onclick="document.getElementById('cancel-modal').remove()" class="px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 rounded-lg">Keep Order</button>
                        <button type="submit" id="cancel-btn" class="px-5 py-2 text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow flex items-center gap-1.5">
                            <i data-lucide="ban" class="w-4 h-4"></i> Cancel Order
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    lucide.createIcons();
};

window.submitCancelOrder = async function(e, orderId) {
    e.preventDefault();
    const btn = document.getElementById('cancel-btn');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Cancelling...`;
    lucide.createIcons();
    try {
        const preset = document.getElementById('cancel-reason-preset').value;
        const detail = document.getElementById('cancel-reason').value.trim();
        const reason = preset && preset !== 'OTHER' ? `${preset}${detail ? ' — ' + detail : ''}` : detail;
        if (!reason) throw new Error('Please provide a reason');

        await window.db.cancelOrder(orderId, reason);
        document.getElementById('cancel-modal').remove();
        showToast('Order cancelled', 'success');
        openOrderDrawer(orderId);
        if (['#/orders', '#/dashboard', '#/board'].includes(location.hash)) router();
    } catch (err) {
        showToast(err.message || 'Failed to cancel', 'error');
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="ban" class="w-4 h-4"></i> Cancel Order`;
        lucide.createIcons();
    }
};

window.restoreOrderConfirm = function(orderId) {
    if (!confirm('Restore this order? It will go back to its previous workflow stage.')) return;
    window.db.restoreOrder(orderId).then(() => {
        showToast('Order restored', 'success');
        openOrderDrawer(orderId);
        if (['#/orders', '#/dashboard', '#/board'].includes(location.hash)) router();
    }).catch(err => showToast(err.message, 'error'));
};

// ==========================================
// ==========================================
// 📱 MOBILE VIEW — Dispatch-only optimized
// ==========================================

async function renderMobileHome(container) {
    location.hash = '#/mobile/orders';
}

async function renderMobileOrders(container) {
    // Hide sidebar + topbar on mobile view
    document.body.classList.add('mobile-view');

    container.innerHTML = renderLoadingState();

    // BMH has no accept/assign workflow — just show all active orders.
    const allOrders = (await window.db.getOrders()) || [];
    const activeOrders = allOrders.filter(o => !o.is_completed && !o.is_cancelled);

    window.__mobileOrderData = { activeOrders };

    const delayedCount = activeOrders.filter(o => o.is_delayed).length;

    container.innerHTML = `
        <div class="min-h-screen bg-gray-50" style="padding-bottom: calc(80px + env(safe-area-inset-bottom, 0px))">
            <!-- Compact Mobile Header -->
            <header class="bg-gradient-to-r from-indigo-600 to-purple-700 text-white sticky top-0 z-30 shadow-md" style="padding-top: env(safe-area-inset-top, 0px)">
                <div class="px-4 py-3 flex items-center justify-between" style="min-height: 56px">
                    <div class="flex items-center gap-2.5">
                        <img src="/web-app-manifest-192x192.png" alt="Bansal Metrial House" class="w-10 h-10 rounded-lg">
                        <div>
                            <h1 class="font-extrabold text-base leading-tight">BMH Dispatch</h1>
                            <p class="text-[10px] text-indigo-200 mt-0.5 font-medium">${activeOrders.length} active</p>
                        </div>
                    </div>
                    <button onclick="renderMobileOrders(document.getElementById('main-content'))"
                        class="text-white/70 hover:text-white p-2 rounded-xl active:bg-white/10 transition-colors">
                        <i data-lucide="refresh-cw" class="w-4 h-4"></i>
                    </button>
                </div>
            </header>

            <!-- Orders List -->
            <div id="mobile-orders-list" class="px-3 pt-3 space-y-2.5">
                ${activeOrders.length === 0 ? `
                    <div class="text-center py-16 px-6">
                        <div class="w-16 h-16 bg-emerald-50 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-sm">
                            <i data-lucide="check-circle-2" class="w-9 h-9 text-emerald-400"></i>
                        </div>
                        <p class="font-bold text-gray-700 text-lg">All caught up!</p>
                        <p class="text-sm text-gray-400 mt-1.5">No active orders</p>
                    </div>
                ` : activeOrders.map(o => renderMobileOrderCard(o)).join('')}
            </div>
        </div>`;

    // Bottom nav injected directly onto <body> so position:fixed is relative
    // to the viewport, not broken by #main-content's CSS animation.
    document.getElementById('mobile-bottom-nav')?.remove();
    const navEl = document.createElement('nav');
    navEl.className = 'mobile-bottom-nav';
    navEl.id = 'mobile-bottom-nav';
    navEl.innerHTML = `
        <button class="mob-nav-tab active" data-mob-tab="all" onclick="switchMobileTab('all')">
            <i data-lucide="list" class="w-[22px] h-[22px]"></i>
            <span>All</span>
        </button>
        <button class="mob-nav-center" onclick="location.hash='#/orders/new'" aria-label="New order">
            <div class="mob-nav-plus">
                <i data-lucide="plus" class="w-6 h-6 text-white"></i>
            </div>
            <span class="mob-nav-center-label">New</span>
        </button>
        <button class="mob-nav-tab" onclick="showMobileMoreSheet()">
            <i data-lucide="more-horizontal" class="w-[22px] h-[22px]"></i>
            <span>More</span>
            ${delayedCount > 0 ? `<span class="mob-nav-badge" style="background:#f59e0b">${delayedCount > 9 ? '9+' : delayedCount}</span>` : ''}
        </button>`;
    document.body.appendChild(navEl);

    lucide.createIcons();
}

function renderMobileOrderCard(o) {
    const stageName = o.current_step ? stepName(o.current_step) : 'Dispatched';
    const dateStr = o.created_at ? new Date(o.created_at).toLocaleDateString('en-IN', {day:'2-digit', month:'short'}) : '—';

    // Stage progress dots — 6 submittable steps
    const stageDots = stepsDirectory.map(code => {
        let cls = 'stage-dot';
        const idx = stepsDirectory.indexOf(code);
        const curIdx = stepsDirectory.indexOf(o.current_step);
        if (o.is_completed || (curIdx !== -1 && idx < curIdx)) cls += ' done';
        else if (code === o.current_step) cls += ' current';
        return `<span class="${cls}"></span>`;
    }).join('');

    return `
        <div onclick="openOrderDrawer('${o.id}')" class="mob-order-card${o.is_delayed ? ' is-delayed' : ''}">
            <!-- Badges row -->
            <div class="flex items-center gap-1.5 mb-2.5 flex-wrap">
                <span class="font-mono text-[11px] font-extrabold text-indigo-700 bg-indigo-50 px-2 py-0.5 rounded-md">${o.order_code}</span>
                ${o.is_delayed ? '<span class="text-[10px] font-extrabold text-red-700 bg-red-50 px-2 py-0.5 rounded-md">⚠ DELAYED</span>' : ''}
            </div>
            <!-- Customer -->
            <div class="flex items-start justify-between gap-3 mb-3">
                <div class="flex-1 min-w-0">
                    <h3 class="font-extrabold text-gray-900 leading-snug" style="font-size:17px">${escapeHtml(o.customer_name)}</h3>
                    ${o.customer_phone ? `<p class="text-sm text-gray-400 mt-0.5 font-medium">${o.customer_phone}</p>` : ''}
                </div>
                <div class="text-right flex-shrink-0">
                    <div class="text-xs text-gray-400 mt-1">${dateStr}</div>
                </div>
            </div>
            <!-- Stage progress + open -->
            <div class="flex items-center justify-between pt-2.5 border-t border-gray-100">
                <div>
                    <div class="stage-dots mb-1.5">${stageDots}</div>
                    <span class="text-xs font-bold text-gray-600">${stageName}</span>
                </div>
                <div class="mob-card-open-btn">
                    <i data-lucide="chevron-right" class="w-4 h-4 text-indigo-500"></i>
                </div>
            </div>
        </div>`;
}

window.exitMobileView = function() {
    localStorage.setItem('bmh_force_desktop', '1');
    document.getElementById('mobile-bottom-nav')?.remove();
    document.body.classList.remove('mobile-view');
    location.hash = '#/dashboard';
    location.reload();
};

// Bottom nav tab switching
window.switchMobileTab = function(tab) {
    document.querySelectorAll('.mob-nav-tab[data-mob-tab]').forEach(t => {
        t.classList.toggle('active', t.dataset.mobTab === tab);
    });

    const { activeOrders } = window.__mobileOrderData || {};
    const list = document.getElementById('mobile-orders-list');
    if (!list || !activeOrders) return;

    const filtered = tab === 'delayed' ? activeOrders.filter(o => o.is_delayed) : activeOrders;
    const emptyMessages = { all: 'No active orders', delayed: 'No delayed orders — all on time!' };

    if (!filtered || filtered.length === 0) {
        list.innerHTML = `
            <div class="text-center py-16 px-6">
                <div class="w-16 h-16 bg-gray-50 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-sm">
                    <i data-lucide="check-circle-2" class="w-9 h-9 text-gray-300"></i>
                </div>
                <p class="font-bold text-gray-500 text-base">${emptyMessages[tab] || 'No orders'}</p>
            </div>`;
    } else {
        list.innerHTML = filtered.map(o => renderMobileOrderCard(o)).join('');
    }
    lucide.createIcons();
};

// Phase 4.4: More action sheet
window.showMobileMoreSheet = function() {
    const { activeOrders } = window.__mobileOrderData || {};
    const delayedCount = (activeOrders || []).filter(o => o.is_delayed).length;

    const existing = document.getElementById('mobile-more-sheet');
    if (existing) { existing.remove(); return; }

    const sheet = document.createElement('div');
    sheet.id = 'mobile-more-sheet';
    sheet.innerHTML = `
        <div class="fixed inset-0 bg-black/40 z-[90]" onclick="document.getElementById('mobile-more-sheet').remove()"></div>
        <div class="fixed bottom-0 left-0 right-0 z-[91] bg-white rounded-t-2xl shadow-2xl" style="padding-bottom: env(safe-area-inset-bottom, 16px)">
            <div class="w-9 h-1 bg-gray-200 rounded-full mx-auto mt-3 mb-2"></div>
            <div class="px-3 pb-3 space-y-1">
                <button onclick="switchMobileTab('delayed'); document.getElementById('mobile-more-sheet').remove()"
                    class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left active:bg-amber-50 transition-colors">
                    <div class="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center flex-shrink-0">
                        <i data-lucide="alert-triangle" class="w-5 h-5 text-amber-600"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-gray-800">Delayed Orders</div>
                        <div class="text-xs text-gray-400 mt-0.5">${delayedCount} order${delayedCount !== 1 ? 's' : ''} need${delayedCount === 1 ? 's' : ''} attention</div>
                    </div>
                    ${delayedCount > 0 ? `<span class="bg-amber-500 text-white text-xs font-extrabold px-2 py-1 rounded-full min-w-[24px] text-center">${delayedCount}</span>` : ''}
                </button>
                <button onclick="renderMobileOrders(document.getElementById('main-content')); document.getElementById('mobile-more-sheet')?.remove()"
                    class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left active:bg-gray-50 transition-colors">
                    <div class="w-10 h-10 bg-indigo-50 rounded-xl flex items-center justify-center flex-shrink-0">
                        <i data-lucide="refresh-cw" class="w-5 h-5 text-indigo-600"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-gray-800">Refresh</div>
                        <div class="text-xs text-gray-400 mt-0.5">Fetch latest orders</div>
                    </div>
                </button>
                <button onclick="exitMobileView(); document.getElementById('mobile-more-sheet')?.remove()"
                    class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left active:bg-gray-50 transition-colors">
                    <div class="w-10 h-10 bg-gray-100 rounded-xl flex items-center justify-center flex-shrink-0">
                        <i data-lucide="monitor" class="w-5 h-5 text-gray-500"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-gray-800">Desktop View</div>
                        <div class="text-xs text-gray-400 mt-0.5">Switch to full desktop</div>
                    </div>
                </button>
                <button onclick="handleLogout(); document.getElementById('mobile-more-sheet')?.remove()"
                    class="w-full flex items-center gap-3 px-4 py-3 rounded-xl text-left active:bg-red-50 transition-colors">
                    <div class="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0">
                        <i data-lucide="log-out" class="w-5 h-5 text-red-500"></i>
                    </div>
                    <div class="flex-1 min-w-0">
                        <div class="font-bold text-red-600">Log Out</div>
                        <div class="text-xs text-gray-400 mt-0.5">Sign out of BMH Dispatch</div>
                    </div>
                </button>
            </div>
        </div>`;
    document.body.appendChild(sheet);
    lucide.createIcons();
};

// HELPERS
// ==========================================
function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const colors = { error: 'bg-red-600', success: 'bg-emerald-600', info: 'bg-gray-900' };
    const icons  = { error: 'alert-triangle', success: 'check-circle', info: 'info' };
    const toast  = document.createElement('div');
    toast.className = `${colors[type] || colors.info} text-white px-4 py-3 rounded-lg shadow-lg text-sm font-medium toast-enter flex items-center gap-2 max-w-sm`;
    toast.innerHTML = `
        <i data-lucide="${icons[type] || icons.info}" class="w-4 h-4 flex-shrink-0"></i>
        <span class="flex-1">${msg}</span>
        <div class="toast-progress"></div>`;
    container.appendChild(toast);
    lucide.createIcons();
    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 280);
    }, 3500);
}

function renderLoadingState() {
    return `
    <div class="p-6 space-y-3">
        ${Array.from({length: 5}, (_, i) => `
        <div class="bg-white rounded-xl border border-gray-100 p-4 flex items-center gap-3">
            <span class="skeleton-line flex-shrink-0 rounded-xl" style="width:40px;height:40px"></span>
            <div class="flex-1 space-y-2">
                <span class="skeleton-line" style="height:14px;width:${32 + (i % 3) * 18}%"></span>
                <span class="skeleton-line" style="height:11px;width:${52 + (i % 2) * 22}%;opacity:.7"></span>
            </div>
            <span class="skeleton-line rounded-full" style="height:22px;width:68px"></span>
        </div>`).join('')}
    </div>`;
}

// ==========================================
// 💫 RIPPLE EFFECT — global button click feedback
// ==========================================
document.addEventListener('click', function(e) {
    const btn = e.target.closest('button:not([disabled])');
    if (!btn || btn.classList.contains('no-ripple')) return;
    const rect = btn.getBoundingClientRect();
    const wave = document.createElement('span');
    wave.className = 'ripple-wave';
    wave.style.left = (e.clientX - rect.left) + 'px';
    wave.style.top  = (e.clientY - rect.top)  + 'px';
    btn.appendChild(wave);
    wave.addEventListener('animationend', () => wave.remove(), { once: true });
}, true);

function formatINR(num) {
    if (!num && num !== 0) return '0';
    return Number(num).toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

function formatDelay(minutes) {
    if (!minutes || minutes < 0) return '0m';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const mins = Math.floor(minutes % 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function formatRelativeTime(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 2592000) return `${Math.floor(diff / 86400)}d ago`;
    return d.toLocaleDateString();
}

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
        closeOrderDrawer();
    }
});

// ==========================================
// 📤 CUSTOMER PORTAL — SHARE LINK
// ==========================================
window.generateShareLink = async function(orderId, orderCode, customerPhone) {
    try {
        const token = await window.db.createShareToken(orderId, currentOrgId);
        const baseUrl = window.location.origin + window.location.pathname.replace(/index\.html$/, '');
        const shareUrl = `${baseUrl}track.html?t=${token}`;
        showShareDialog(orderCode, shareUrl, customerPhone);
    } catch (err) {
        console.error(err);
        showToast(err.message || 'Failed to generate link', 'error');
    }
};

function showShareDialog(orderCode, url, phone) {
    const html = `
        <div id="share-modal" class="fixed inset-0 z-[70] flex items-center justify-center modal-backdrop p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden border border-gray-100">
                <div class="bg-gradient-to-br from-violet-600 to-pink-600 p-6 text-white">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="font-extrabold text-xl">Share Tracking Link</h3>
                        <button onclick="document.getElementById('share-modal').remove()" class="text-white/80 hover:text-white bg-white/10 hover:bg-white/20 rounded-full p-1.5">
                            <i data-lucide="x" class="w-5 h-5"></i>
                        </button>
                    </div>
                    <p class="text-sm text-white/90">Share order <span class="font-mono font-bold">${orderCode}</span> with your customer</p>
                </div>
                <div class="p-6 space-y-4">
                    <div>
                        <label class="block text-xs font-bold text-gray-500 uppercase tracking-wider mb-2">Tracking URL</label>
                        <div class="flex gap-2">
                            <input type="text" id="share-url" readonly value="${url}" class="flex-1 bg-gray-50 border border-gray-200 rounded-lg p-2.5 text-xs font-mono text-gray-700 outline-none">
                            <button onclick="copyShareUrl()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg text-xs font-bold flex items-center gap-1.5">
                                <i data-lucide="copy" class="w-3.5 h-3.5"></i> Copy
                            </button>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-2 pt-2">
                        ${phone ? `
                        <a href="https://wa.me/${phone.startsWith('91') ? phone : '91' + phone}?text=${encodeURIComponent('Hello! Track your order ' + orderCode + ' here: ' + url)}"
                           target="_blank"
                           class="bg-green-500 hover:bg-green-600 text-white rounded-lg px-3 py-3 text-sm font-bold flex items-center justify-center gap-2 transition">
                            <i data-lucide="message-circle" class="w-4 h-4"></i> WhatsApp
                        </a>` : `
                        <a href="https://wa.me/?text=${encodeURIComponent('Track your order ' + orderCode + ': ' + url)}"
                           target="_blank"
                           class="bg-green-500 hover:bg-green-600 text-white rounded-lg px-3 py-3 text-sm font-bold flex items-center justify-center gap-2 transition">
                            <i data-lucide="message-circle" class="w-4 h-4"></i> WhatsApp
                        </a>`}
                        <a href="mailto:?subject=${encodeURIComponent('Order ' + orderCode + ' — Tracking')}&body=${encodeURIComponent('Track your order here: ' + url)}"
                           class="bg-blue-500 hover:bg-blue-600 text-white rounded-lg px-3 py-3 text-sm font-bold flex items-center justify-center gap-2 transition">
                            <i data-lucide="mail" class="w-4 h-4"></i> Email
                        </a>
                    </div>
                    <div class="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex gap-2">
                        <i data-lucide="info" class="w-4 h-4 flex-shrink-0 mt-0.5"></i>
                        <span>This link is unique and secure. Customer can view order status but cannot edit anything.</span>
                    </div>
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    lucide.createIcons();
}

window.copyShareUrl = function() {
    const input = document.getElementById('share-url');
    input.select();
    navigator.clipboard.writeText(input.value);
    showToast('Link copied to clipboard!', 'success');
};

// ==========================================
// 👥 CUSTOMERS PAGE
// ==========================================
async function renderCustomers(container) {
    container.innerHTML = renderLoadingState();
    const customers = (await window.db.getAllCustomers()) || [];
    window.__allCustomers = customers;

    container.innerHTML = `
        <div class="max-w-7xl mx-auto animate-in">
            <div class="flex items-center justify-between mb-5">
                <div>
                    <h1 class="text-2xl font-extrabold tracking-tight">Customers</h1>
                    <p class="text-sm text-gray-500 mt-1">${customers.length} customers in your database</p>
                </div>
                <button onclick="openAddCustomerModal()" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-indigo-700 shadow-md flex items-center gap-2">
                    <i data-lucide="plus" class="w-4 h-4"></i> Add Customer
                </button>
            </div>
            <div class="bg-white rounded-xl shadow-sm border border-gray-200 p-3 mb-4 flex items-center gap-2 flex-wrap">
                <div class="relative flex-1 min-w-[240px]">
                    <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"></i>
                    <input type="text" id="cust-search" oninput="filterCustomersList()" placeholder="Search by name, phone, city..." class="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:bg-white focus:ring-2 focus:ring-indigo-200 outline-none">
                </div>
                <button onclick="filterCustomersVIP()" id="vip-filter" class="text-xs font-bold border border-gray-200 hover:border-amber-400 px-3 py-2 rounded-lg flex items-center gap-1.5 transition">
                    <i data-lucide="star" class="w-3.5 h-3.5"></i> VIP Only
                </button>
                <select id="cust-sort" onchange="filterCustomersList()" class="text-xs font-semibold border border-gray-200 rounded-lg px-3 py-2 bg-white outline-none">
                    <option value="name">Sort: Name (A-Z)</option>
                    <option value="ltv">Sort: Lifetime Value</option>
                    <option value="orders">Sort: Total Orders</option>
                    <option value="recent">Sort: Most Recent</option>
                </select>
            </div>
            <div id="customers-grid" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                ${customers.length === 0 ? `
                    <div class="col-span-3 bg-white rounded-xl border border-gray-200 p-12 text-center">
                        <i data-lucide="users" class="w-12 h-12 mx-auto text-gray-300 mb-3"></i>
                        <p class="font-semibold text-gray-500">No customers yet</p>
                        <button onclick="openAddCustomerModal()" class="mt-4 text-indigo-600 font-bold hover:underline">+ Add your first customer</button>
                    </div>
                ` : customers.map(c => renderCustomerCard(c)).join('')}
            </div>
        </div>
        <div id="customer-drawer-root"></div>`;
}

function renderCustomerCard(c) {
    const initials = (c.name || 'U').substring(0,2).toUpperCase();
    const colors = ['#4f46e5','#8b5cf6','#ec4899','#f97316','#10b981','#0284c7','#dc2626'];
    const color = colors[(c.name?.charCodeAt(0) || 0) % colors.length];

    return `
        <div data-customer-id="${c.id}" onclick="openCustomerDrawer('${c.id}')" class="bg-white rounded-xl shadow-sm border border-gray-200 p-4 hover:shadow-md hover:border-indigo-300 transition cursor-pointer">
            <div class="flex items-start gap-3 mb-3">
                <div class="w-12 h-12 rounded-xl flex items-center justify-center text-white font-extrabold text-sm shadow-md flex-shrink-0" style="background:${color}">
                    ${initials}
                </div>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <h3 class="font-extrabold text-gray-900 truncate">${escapeHtml(c.name)}</h3>
                        ${c.is_vip ? '<span class="text-xs">⭐</span>' : ''}
                    </div>
                    <p class="text-xs text-gray-500 truncate">${c.phone || c.email || 'No contact'}</p>
                    ${c.city ? `<p class="text-[10px] text-gray-400 mt-0.5">📍 ${c.city}${c.state ? ', ' + c.state : ''}</p>` : ''}
                </div>
            </div>
            <div class="grid grid-cols-2 gap-2 pt-3 border-t border-gray-100">
                <div>
                    <div class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Orders</div>
                    <div class="font-bold text-gray-900">${c.total_orders || 0}</div>
                </div>
                <div>
                    <div class="text-[10px] text-gray-400 font-bold uppercase tracking-wider">Lifetime</div>
                    <div class="font-bold text-gray-900 font-mono">₹${formatINR(c.lifetime_value)}</div>
                </div>
            </div>
        </div>`;
}

window.filterCustomersList = function() {
    const q = document.getElementById('cust-search').value.toLowerCase().trim();
    const sort = document.getElementById('cust-sort').value;
    const vipOnly = document.getElementById('vip-filter').classList.contains('active-filter');

    let filtered = (window.__allCustomers || []).filter(c => {
        if (vipOnly && !c.is_vip) return false;
        if (!q) return true;
        return (c.name || '').toLowerCase().includes(q)
            || (c.phone || '').includes(q)
            || (c.city || '').toLowerCase().includes(q);
    });

    if (sort === 'ltv')      filtered.sort((a,b) => (b.lifetime_value||0) - (a.lifetime_value||0));
    else if (sort === 'orders') filtered.sort((a,b) => (b.total_orders||0) - (a.total_orders||0));
    else if (sort === 'recent') filtered.sort((a,b) => new Date(b.last_order_at||0) - new Date(a.last_order_at||0));
    else filtered.sort((a,b) => (a.name||'').localeCompare(b.name||''));

    const grid = document.getElementById('customers-grid');
    grid.innerHTML = filtered.length === 0
        ? `<div class="col-span-3 text-center text-gray-400 py-8">No customers match your filters</div>`
        : filtered.map(c => renderCustomerCard(c)).join('');
    lucide.createIcons();
};

window.filterCustomersVIP = function() {
    const btn = document.getElementById('vip-filter');
    btn.classList.toggle('active-filter');
    if (btn.classList.contains('active-filter')) {
        btn.style.background = '#fef3c7';
        btn.style.borderColor = '#f59e0b';
        btn.style.color = '#92400e';
    } else {
        btn.style.background = '';
        btn.style.borderColor = '';
        btn.style.color = '';
    }
    filterCustomersList();
};

// ==========================================
// 👤 CUSTOMER DRAWER
// ==========================================
window.openCustomerDrawer = async function(customerId) {
    let root = document.getElementById('customer-drawer-root') || document.getElementById('drawer-root');
    if (!root) {
        document.body.insertAdjacentHTML('beforeend', '<div id="customer-drawer-root"></div>');
        root = document.getElementById('customer-drawer-root');
    }

    root.innerHTML = `
        <div id="cust-drawer-overlay" class="drawer-overlay" onclick="closeCustomerDrawer()"></div>
        <aside id="customer-drawer" class="drawer-panel">
            <div class="flex justify-center items-center h-full"><div class="spinner"></div></div>
        </aside>`;

    requestAnimationFrame(() => {
        document.getElementById('cust-drawer-overlay')?.classList.add('open');
        document.getElementById('customer-drawer')?.classList.add('open');
    });

    try {
        const { customer, orders } = await window.db.getCustomerDetail(customerId);
        if (!customer) {
            document.getElementById('customer-drawer').innerHTML = `<div class="p-8 text-center text-red-500">Customer not found</div>`;
            return;
        }
        renderCustomerDrawer(customer, orders);
    } catch (err) {
        document.getElementById('customer-drawer').innerHTML = `<div class="p-8 text-center text-red-500">${err.message}</div>`;
    }
};

window.closeCustomerDrawer = function() {
    document.getElementById('cust-drawer-overlay')?.classList.remove('open');
    document.getElementById('customer-drawer')?.classList.remove('open');
    setTimeout(() => {
        const root = document.getElementById('customer-drawer-root');
        if (root) root.innerHTML = '';
    }, 300);
};

function renderCustomerDrawer(customer, orders) {
    const initials = (customer.name || 'U').substring(0,2).toUpperCase();
    const colors = ['#4f46e5','#8b5cf6','#ec4899','#f97316','#10b981','#0284c7'];
    const color = colors[(customer.name?.charCodeAt(0) || 0) % colors.length];

    const activeOrders = orders.filter(o => !o.is_completed).length;
    const completedOrders = orders.filter(o => o.is_completed).length;
    const delayedOrders = orders.filter(o => o.is_delayed && !o.is_completed).length;

    const ordersHTML = orders.length === 0
        ? `<div class="p-6 text-center text-gray-400"><i data-lucide="package" class="w-10 h-10 mx-auto mb-2"></i><p class="text-sm">No orders yet</p></div>`
        : orders.map(o => `
            <div onclick="closeCustomerDrawer(); setTimeout(() => openOrderDrawer('${o.id}'), 350);" class="flex items-center justify-between p-3 hover:bg-indigo-50 rounded-lg cursor-pointer transition border border-gray-100 mb-2">
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                        <span class="font-mono font-bold text-xs text-indigo-600">${o.order_code}</span>
                        ${o.is_completed ? '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-1.5 py-0.5 rounded">DONE</span>' : ''}
                        ${o.is_delayed && !o.is_completed ? '<span class="text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">DELAYED</span>' : ''}
                    </div>
                    <div class="text-xs text-gray-500 mt-0.5">${o.order_date ? new Date(o.order_date).toLocaleDateString() : ''} · ${o.current_step ? stepName(o.current_step) : 'Completed'}</div>
                </div>
                <div class="text-right">
                    <div class="font-bold text-sm font-mono">₹${formatINR(o.order_value)}</div>
                </div>
            </div>`).join('');

    document.getElementById('customer-drawer').innerHTML = `
        <div class="flex justify-between p-5 border-b border-gray-100">
            <div class="flex items-center gap-3">
                <div class="w-14 h-14 rounded-2xl flex items-center justify-center text-white font-extrabold shadow-lg" style="background:${color}">
                    ${initials}
                </div>
                <div>
                    <div class="flex items-center gap-2">
                        <h2 class="text-xl font-extrabold text-gray-900">${escapeHtml(customer.name)}</h2>
                        ${customer.is_vip ? '<span title="VIP" class="text-amber-500">⭐</span>' : ''}
                    </div>
                    <p class="text-xs text-gray-500 mt-0.5">${customer.phone || customer.email || 'No contact'}</p>
                </div>
            </div>
            <button onclick="closeCustomerDrawer()" class="text-gray-400 hover:text-gray-900 p-1.5 hover:bg-gray-100 rounded-full">
                <i data-lucide="x" class="w-5 h-5"></i>
            </button>
        </div>

        <div class="drawer-body p-5 space-y-4">
            <div class="grid grid-cols-3 gap-2">
                ${customer.phone ? `
                <a href="tel:${customer.phone}" class="flex flex-col items-center gap-1 p-3 bg-blue-50 hover:bg-blue-100 rounded-xl transition">
                    <i data-lucide="phone" class="w-4 h-4 text-blue-600"></i>
                    <span class="text-[10px] font-bold text-blue-700 uppercase tracking-wider">Call</span>
                </a>
                <a href="https://wa.me/${customer.phone.replace(/[^0-9]/g,'').replace(/^91?/, '91')}" target="_blank" class="flex flex-col items-center gap-1 p-3 bg-green-50 hover:bg-green-100 rounded-xl transition">
                    <i data-lucide="message-circle" class="w-4 h-4 text-green-600"></i>
                    <span class="text-[10px] font-bold text-green-700 uppercase tracking-wider">WhatsApp</span>
                </a>
                ` : `<div class="col-span-2"></div>`}
                <button onclick="toggleVIP('${customer.id}', ${!customer.is_vip})" class="flex flex-col items-center gap-1 p-3 ${customer.is_vip ? 'bg-amber-50 hover:bg-amber-100' : 'bg-gray-50 hover:bg-gray-100'} rounded-xl transition">
                    <i data-lucide="star" class="w-4 h-4 ${customer.is_vip ? 'text-amber-600' : 'text-gray-400'}"></i>
                    <span class="text-[10px] font-bold ${customer.is_vip ? 'text-amber-700' : 'text-gray-600'} uppercase tracking-wider">${customer.is_vip ? 'VIP ✓' : 'Mark VIP'}</span>
                </button>
            </div>

            <div class="bg-gradient-to-br from-indigo-50 to-purple-50 rounded-xl p-4 border border-indigo-100">
                <div class="grid grid-cols-2 gap-3">
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600/70 uppercase tracking-wider">Total Orders</div>
                        <div class="text-2xl font-extrabold text-gray-900 mt-0.5">${customer.total_orders || 0}</div>
                    </div>
                    <div>
                        <div class="text-[10px] font-bold text-indigo-600/70 uppercase tracking-wider">Lifetime Value</div>
                        <div class="text-2xl font-extrabold text-gray-900 mt-0.5 font-mono">₹${formatINR(customer.lifetime_value)}</div>
                    </div>
                </div>
                <div class="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-indigo-100">
                    <div class="text-center">
                        <div class="text-sm font-bold text-blue-600">${activeOrders}</div>
                        <div class="text-[9px] text-gray-500 uppercase font-bold">Active</div>
                    </div>
                    <div class="text-center">
                        <div class="text-sm font-bold text-emerald-600">${completedOrders}</div>
                        <div class="text-[9px] text-gray-500 uppercase font-bold">Done</div>
                    </div>
                    <div class="text-center">
                        <div class="text-sm font-bold text-red-600">${delayedOrders}</div>
                        <div class="text-[9px] text-gray-500 uppercase font-bold">Delayed</div>
                    </div>
                </div>
            </div>

            <div class="bg-white border border-gray-200 rounded-xl p-4 space-y-2">
                <div class="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-2">Contact Details</div>
                ${customer.email ? `<div class="flex items-center gap-2 text-sm"><i data-lucide="mail" class="w-3.5 h-3.5 text-gray-400"></i>${customer.email}</div>` : ''}
                ${customer.address ? `<div class="flex items-start gap-2 text-sm"><i data-lucide="map-pin" class="w-3.5 h-3.5 text-gray-400 mt-0.5"></i><span>${customer.address}${customer.city ? ', ' + customer.city : ''}${customer.state ? ', ' + customer.state : ''}${customer.pincode ? ' - ' + customer.pincode : ''}</span></div>` : ''}
                ${customer.gstin ? `<div class="flex items-center gap-2 text-sm font-mono"><i data-lucide="file-text" class="w-3.5 h-3.5 text-gray-400"></i>${customer.gstin}</div>` : ''}
                ${(!customer.email && !customer.address && !customer.gstin) ? `<button onclick="editCustomer('${customer.id}')" class="text-xs text-indigo-600 font-bold hover:underline">+ Add contact details</button>` : ''}
            </div>

            <div>
                <div class="flex items-center justify-between mb-2">
                    <div class="text-xs font-bold text-gray-500 uppercase tracking-wider">Order History (${orders.length})</div>
                </div>
                ${ordersHTML}
            </div>
        </div>`;
    lucide.createIcons();
}

window.toggleVIP = async function(customerId, makeVIP) {
    try {
        await window.db.supabase.from('customers').update({ is_vip: makeVIP }).eq('id', customerId);
        showToast(makeVIP ? '⭐ Marked as VIP' : 'VIP status removed', 'success');
        openCustomerDrawer(customerId);
    } catch (err) { showToast(err.message, 'error'); }
};

window.openAddCustomerModal = function() {
    const html = `
        <div id="add-cust-modal" class="fixed inset-0 z-[70] flex items-center justify-center modal-backdrop p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden">
                <div class="p-5 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                    <h3 class="font-black text-lg">Add Customer</h3>
                    <button onclick="document.getElementById('add-cust-modal').remove()" class="text-gray-400 hover:text-gray-900 p-1.5 hover:bg-gray-100 rounded-full">
                        <i data-lucide="x" class="w-5 h-5"></i>
                    </button>
                </div>
                <form onsubmit="submitNewCustomer(event)" class="p-6 space-y-4">
                    <div>
                        <label class="block text-sm font-semibold text-gray-700 mb-1">Name *</label>
                        <input type="text" id="nc-name" required class="w-full border rounded-lg p-2.5 text-sm">
                    </div>
                    <div class="grid grid-cols-2 gap-3">
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1">Phone</label>
                            <input type="tel" id="nc-phone" placeholder="9876543210" class="w-full border rounded-lg p-2.5 text-sm">
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1">Email</label>
                            <input type="email" id="nc-email" class="w-full border rounded-lg p-2.5 text-sm">
                        </div>
                    </div>
                    <div>
                        <label class="block text-sm font-semibold text-gray-700 mb-1">Address</label>
                        <textarea id="nc-address" rows="2" class="w-full border rounded-lg p-2.5 text-sm"></textarea>
                    </div>
                    <div class="grid grid-cols-3 gap-3">
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1">City</label>
                            <input type="text" id="nc-city" class="w-full border rounded-lg p-2.5 text-sm">
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1">State</label>
                            <input type="text" id="nc-state" class="w-full border rounded-lg p-2.5 text-sm">
                        </div>
                        <div>
                            <label class="block text-sm font-semibold text-gray-700 mb-1">Pincode</label>
                            <input type="text" id="nc-pincode" class="w-full border rounded-lg p-2.5 text-sm">
                        </div>
                    </div>
                    <div>
                        <label class="block text-sm font-semibold text-gray-700 mb-1">GSTIN</label>
                        <input type="text" id="nc-gstin" placeholder="22AAAAA0000A1Z5" class="w-full border rounded-lg p-2.5 text-sm font-mono uppercase">
                    </div>
                    <label class="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg cursor-pointer">
                        <input type="checkbox" id="nc-vip" class="w-4 h-4">
                        <span class="text-sm font-semibold">⭐ Mark as VIP customer</span>
                    </label>
                    <div class="flex justify-end gap-2 pt-3">
                        <button type="button" onclick="document.getElementById('add-cust-modal').remove()" class="px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
                        <button type="submit" class="px-5 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow flex items-center gap-1.5">
                            <i data-lucide="check" class="w-4 h-4"></i> Add
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    lucide.createIcons();
};

window.submitNewCustomer = async function(e) {
    e.preventDefault();
    try {
        const data = {
            organization_id: currentOrgId,
            name: document.getElementById('nc-name').value.trim(),
            phone: document.getElementById('nc-phone').value.trim() || null,
            email: document.getElementById('nc-email').value.trim() || null,
            address: document.getElementById('nc-address').value.trim() || null,
            city: document.getElementById('nc-city').value.trim() || null,
            state: document.getElementById('nc-state').value.trim() || null,
            pincode: document.getElementById('nc-pincode').value.trim() || null,
            gstin: document.getElementById('nc-gstin').value.trim().toUpperCase() || null,
            is_vip: document.getElementById('nc-vip').checked
        };
        await window.db.supabase.from('customers').insert([data]);
        document.getElementById('add-cust-modal').remove();
        showToast('Customer added!', 'success');
        router();
    } catch (err) { showToast(err.message, 'error'); }
};

window.editCustomer = function(id) {
    showToast('Edit customer coming soon!', 'info');
};

// ==========================================
// 🎛️ FILTER BAR FOR ORDERS PAGE
// ==========================================
window.__orderFilters = { status: 'all', step: 'all', salesPerson: 'all', search: '', type: 'all', dateFrom: '', dateTo: '' };

function renderOrderFilters(allOrders) {
    const f = window.__orderFilters;
    const localToday = new Date().toLocaleDateString('en-CA');

    // ── Status counts (exclude cancelled from All/Active/Today) ──
    const nonCancelled  = allOrders.filter(o => !o.is_cancelled);
    const todayCount    = nonCancelled.filter(o => { const d = o.order_date || o.created_at; return d && new Date(d).toLocaleDateString('en-CA') === localToday; }).length;
    const activeCount   = nonCancelled.filter(o => !o.is_completed).length;
    const delayedCount  = nonCancelled.filter(o => o.is_delayed && !o.is_completed).length;
    const completedCount= nonCancelled.filter(o => o.is_completed).length;
    const cancelledCount= allOrders.filter(o => o.is_cancelled).length;

    // ── Status-filtered pool — type counts must reflect current status ──
    const statusPool = allOrders.filter(o => {
        if (f.status !== 'cancelled' && o.is_cancelled) return false;
        if (f.status === 'cancelled')  return o.is_cancelled;
        if (f.status === 'active')     return !o.is_completed && !o.is_cancelled;
        if (f.status === 'delayed')    return o.is_delayed && !o.is_completed && !o.is_cancelled;
        if (f.status === 'completed')  return o.is_completed && !o.is_cancelled;
        if (f.status === 'today') {
            const d = o.order_date || o.created_at;
            return d && new Date(d).toLocaleDateString('en-CA') === localToday && !o.is_cancelled;
        }
        return !o.is_cancelled;
    });

    // Type counts are now relative to the active status filter
    const blankCount   = statusPool.filter(o => o.type_of_order === 'BLANK').length;
    const printedCount = statusPool.filter(o => o.type_of_order === 'PRINTED').length;
    const bothCount    = statusPool.filter(o => o.type_of_order === 'BLANK AND PRINTED').length;

    const hasFilters = f.status !== 'all' || f.step !== 'all' || f.search || f.type !== 'all' || f.dateFrom || f.dateTo;

    const sChip = (val, label, count, color) => {
        const on = f.status === val;
        return `<button onclick="setOrderFilter('status','${val}')"
            class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold transition-all whitespace-nowrap select-none
            ${on ? `bg-${color}-600 text-white shadow-sm` : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 hover:border-gray-300'}">
            ${label}<span class="${on ? 'bg-white/20' : 'bg-gray-100'} text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-0.5">${count}</span>
        </button>`;
    };

    const tChip = (val, label, count, color) => {
        const on = f.type === val;
        return `<button onclick="setOrderFilter('type','${val}')"
            class="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-semibold transition-all whitespace-nowrap select-none
            ${on ? `bg-${color}-600 text-white shadow-sm` : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50 hover:border-gray-300'}">
            ${label}<span class="${on ? 'bg-white/20' : 'bg-gray-100'} text-[10px] font-bold px-1.5 py-0.5 rounded-full ml-0.5">${count}</span>
        </button>`;
    };

    return `
        <div id="order-filter-bar" class="border-b border-gray-200 bg-white">

            <!-- ROW 1: Search · Date presets · Date range · Clear -->
            <div class="px-4 py-2.5 flex flex-wrap items-center gap-2 border-b border-gray-100">
                <div class="relative flex-1 min-w-[200px] max-w-sm">
                    <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"></i>
                    <input type="text" id="order-search" value="${f.search}"
                        oninput="setOrderFilter('search', this.value)"
                        placeholder="Search order ID, customer, phone…"
                        class="w-full pl-9 pr-3 py-2 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:bg-white focus:ring-2 focus:ring-indigo-100 focus:border-indigo-400 outline-none transition">
                </div>

                <div class="flex items-center gap-1 ml-auto">
                    <button onclick="setDatePreset('today')" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 transition">Today</button>
                    <button onclick="setDatePreset('7days')" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 transition">7d</button>
                    <button onclick="setDatePreset('30days')" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 transition">30d</button>
                    <button onclick="setDatePreset('month')" class="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 transition">Month</button>
                    <div class="w-px h-5 bg-gray-200 mx-0.5"></div>
                    <input type="date" id="filter-date-from" value="${f.dateFrom || ''}"
                        onchange="setOrderFilter('dateFrom', this.value)"
                        class="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition">
                    <span class="text-gray-400 text-xs">—</span>
                    <input type="date" id="filter-date-to" value="${f.dateTo || ''}"
                        onchange="setOrderFilter('dateTo', this.value)"
                        class="text-xs border border-gray-200 rounded-lg px-2 py-1.5 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 transition">
                </div>

                ${hasFilters ? `
                    <button onclick="clearOrderFilters()"
                        class="flex items-center gap-1 text-xs font-semibold text-red-600 hover:bg-red-50 border border-red-200 px-3 py-1.5 rounded-lg transition whitespace-nowrap">
                        <i data-lucide="x" class="w-3.5 h-3.5"></i> Clear
                    </button>` : ''}
            </div>

            <!-- ROW 2: Status chips · divider · Type chips · divider · Stage -->
            <div class="px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">

                <div class="flex items-center gap-1.5 flex-wrap">
                    ${sChip('all',       'All',       nonCancelled.length, 'indigo')}
                    ${sChip('today',     'Today',     todayCount,          'orange')}
                    ${sChip('active',    'Active',    activeCount,         'blue')}
                    ${sChip('delayed',   'Delayed',   delayedCount,        'red')}
                    ${sChip('completed', 'Done',      completedCount,      'emerald')}
                    ${sChip('cancelled', 'Cancelled', cancelledCount,      'gray')}
                </div>

                <div class="w-px h-6 bg-gray-200 self-center hidden sm:block"></div>

                <div class="flex items-center gap-1.5 flex-wrap">
                    ${tChip('all',              'All Types', statusPool.length, 'slate')}
                    ${tChip('BLANK',            'Blank',     blankCount,        'slate')}
                    ${tChip('PRINTED',          'Printed',   printedCount,      'purple')}
                    ${tChip('BLANK AND PRINTED','Both',      bothCount,         'pink')}
                </div>

                <div class="w-px h-6 bg-gray-200 self-center hidden sm:block"></div>

                <select onchange="setOrderFilter('step', this.value)"
                    class="text-xs font-semibold border rounded-xl px-3 py-1.5 bg-white outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100 min-w-[150px] cursor-pointer transition
                    ${f.step !== 'all' ? 'border-indigo-300 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600'}">
                    <option value="all" ${f.step==='all'?'selected':''}>All Stages</option>
                    ${stepsDirectory.map(s => `<option value="${s}" ${f.step===s?'selected':''}>${stepName(s)}</option>`).join('')}
                </select>

            </div>
        </div>`;
}

let __searchDebounce = null;
window.setOrderFilter = function(key, value) {
    window.__orderFilters[key] = value;
    if (key === 'search') {
        clearTimeout(__searchDebounce);
        __searchDebounce = setTimeout(() => applyOrderFilters(false), 250);
    } else {
        applyOrderFilters(true);
    }
};

window.clearOrderFilters = function() {
    window.__orderFilters = { status: 'all', step: 'all', salesPerson: 'all', search: '', type: 'all', dateFrom: '', dateTo: '' };
    router();
};

window.setDatePreset = function(preset) {
    const today = new Date();
    const fmt = (d) => d.toISOString().split('T')[0];
    let from = '', to = fmt(today);
    
    if (preset === 'today') {
        from = fmt(today);
    } else if (preset === '7days') {
        const d = new Date(); d.setDate(d.getDate() - 7);
        from = fmt(d);
    } else if (preset === '30days') {
        const d = new Date(); d.setDate(d.getDate() - 30);
        from = fmt(d);
    } else if (preset === 'month') {
        from = fmt(new Date(today.getFullYear(), today.getMonth(), 1));
    }
    
    window.__orderFilters.dateFrom = from;
    window.__orderFilters.dateTo = to;
    applyOrderFilters();
    router();
};

function applyOrderFilters(updateFilterBar = true) {
    const f = window.__orderFilters;
    const all = window.__allOrders || [];
    const filtered = all.filter(o => {
        // Hide cancelled by default (unless filter is 'cancelled')
        if (f.status !== 'cancelled' && o.is_cancelled) return false;

        // Status filters
        if (f.status === 'cancelled' && !o.is_cancelled) return false;
        if (f.status === 'active' && (o.is_completed || o.is_cancelled)) return false;
        if (f.status === 'delayed' && (!o.is_delayed || o.is_completed || o.is_cancelled)) return false;
        if (f.status === 'completed' && (!o.is_completed || o.is_cancelled)) return false;
        if (f.status === 'today') {
            const localToday = new Date().toLocaleDateString('en-CA');
            const dStr = o.order_date || o.created_at;
            if (!dStr || new Date(dStr).toLocaleDateString('en-CA') !== localToday) return false;
        }
        
        // Type filter
        if (f.type !== 'all' && o.type_of_order !== f.type) return false;
        
        // Stage filter
        if (f.step !== 'all' && o.current_step !== f.step) return false;
        
        // Date range filter
        if (f.dateFrom || f.dateTo) {
            const dStr = o.order_date || o.created_at;
            if (!dStr) return false;
            const orderDate = new Date(dStr).toLocaleDateString('en-CA');
            if (f.dateFrom && orderDate < f.dateFrom) return false;
            if (f.dateTo && orderDate > f.dateTo) return false;
        }
        
        // Search
        if (f.search) {
            const q = f.search.toLowerCase();
            if (!((o.order_code || '').toLowerCase().includes(q)
                || (o.customer_name || '').toLowerCase().includes(q)
                || (o.customer_phone || '').includes(q))) return false;
        }
        return true;
    });
    if (updateFilterBar) {
        const filterBar = document.getElementById('order-filter-bar');
        if (filterBar) {
            const tmp = document.createElement('div');
            tmp.innerHTML = renderOrderFilters(all);
            filterBar.replaceWith(tmp.firstElementChild);
            lucide.createIcons();
        }
    }
    renderOrderRows(filtered);
}

function renderOrderRows(orders) {
    const tbody = document.getElementById('orders-tbody');
    if (!tbody) return;
    if (orders.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-gray-400 text-sm">No orders match your filters</td></tr>`;
        return;
    }
    tbody.innerHTML = orders.map((o, i) => `
        <tr class="order-row-enter hover:bg-indigo-50/50 cursor-pointer"
            style="animation-delay:${Math.min(i * 22, 300)}ms"
            onclick="openOrderDrawer('${o.id}')">
            <td class="px-6 py-3.5 font-mono text-indigo-600 font-bold">${o.order_code}</td>
            <td class="px-6 py-3.5 font-semibold text-gray-900">${escapeHtml(o.customer_name)}</td>
            <td class="px-6 py-3.5 font-medium text-gray-700 font-mono">₹${formatINR(o.order_value)}</td>
            <td class="px-6 py-3.5"><span class="text-[10px] font-bold px-2 py-1 rounded uppercase ${o.dispatch_mode === 'PORTER' ? 'bg-blue-100 text-blue-700' : o.dispatch_mode === 'SELF' ? 'bg-green-100 text-green-700' : o.dispatch_mode === 'DTDC' || o.dispatch_mode === 'TRACKON' ? 'bg-purple-100 text-purple-700' : o.dispatch_mode === 'CARGO' || o.dispatch_mode === 'BUS' ? 'bg-orange-100 text-orange-700' : o.dispatch_mode === 'DELIVERY' ? 'bg-cyan-100 text-cyan-700' : 'bg-gray-100 text-gray-600'}">${o.dispatch_mode || '—'}</span></td>
            <td class="px-6 py-3.5"><span class="text-xs font-bold ${(o.sales_person_name || o.sales_person) ? 'text-indigo-700 bg-indigo-50 px-2 py-1 rounded' : 'text-gray-400'}">${o.sales_person_name || o.sales_person || 'N/A'}</span></td>
            <td class="px-6 py-3.5"><span class="text-xs font-semibold bg-gray-100 text-gray-700 px-2 py-1 rounded">${o.current_step ? stepName(o.current_step) : '✓ Completed'}</span></td>
            <td class="px-6 py-3.5">
                ${o.is_cancelled ? `<span class="px-2.5 py-1 bg-gray-200 text-gray-700 text-[10px] font-bold rounded uppercase">✕ Cancelled</span>`
                  : o.is_completed ? `<span class="px-2.5 py-1 bg-emerald-100 text-emerald-700 text-[10px] font-bold rounded uppercase">Done</span>`
                  : o.is_delayed ? `<span class="px-2.5 py-1 bg-red-100 text-red-700 text-[10px] font-bold rounded uppercase">Delayed</span>`
                  : `<span class="px-2.5 py-1 bg-blue-100 text-blue-700 text-[10px] font-bold rounded uppercase">Active</span>`}
            </td>
        </tr>`).join('');
}

// ==========================================
// 📎 FILE PREVIEW MODAL
// ==========================================
window.previewFile = function(url, title) {
    if (!url) {
        showToast('No file uploaded', 'error');
        return;
    }
    
    // Detect file type from URL
    const ext = url.split('.').pop().toLowerCase().split('?')[0];
    const isImage = ['png','jpg','jpeg','gif','webp','svg'].includes(ext);
    const isPdf = ext === 'pdf';
    const isVideo = ['mp4','mov','webm','quicktime'].includes(ext);
    
    let previewContent = '';
    
    if (isImage) {
        previewContent = `<img src="${url}" alt="${title}" class="max-w-full max-h-[75vh] mx-auto rounded-lg shadow-lg" />`;
    } else if (isPdf) {
        previewContent = `<iframe src="${url}" class="w-full h-[75vh] rounded-lg" style="border: 1px solid #e5e7eb;"></iframe>`;
    } else if (isVideo) {
        previewContent = `<video src="${url}" controls class="max-w-full max-h-[75vh] mx-auto rounded-lg shadow-lg"></video>`;
    } else {
        previewContent = `
            <div class="text-center p-12 bg-gray-50 rounded-lg">
                <i data-lucide="file" class="w-16 h-16 mx-auto text-gray-400 mb-4"></i>
                <p class="text-gray-600 mb-4">Preview not available for this file type</p>
                <a href="${url}" target="_blank" download class="inline-flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-4 py-2 rounded-lg">
                    <i data-lucide="download" class="w-4 h-4"></i> Download File
                </a>
            </div>`;
    }
    
    const html = `
        <div id="file-preview-modal" class="fixed inset-0 z-[80] flex items-center justify-center modal-backdrop p-4" onclick="if(event.target.id==='file-preview-modal') closeFilePreview()">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-hidden border border-gray-100 flex flex-col">
                <div class="p-4 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center flex-shrink-0">
                    <div class="flex items-center gap-3 min-w-0">
                        <div class="w-9 h-9 bg-indigo-50 rounded-lg flex items-center justify-center flex-shrink-0">
                            <i data-lucide="${isImage ? 'image' : isPdf ? 'file-text' : isVideo ? 'video' : 'file'}" class="w-4 h-4 text-indigo-600"></i>
                        </div>
                        <div class="min-w-0">
                            <h3 class="font-extrabold text-gray-900 truncate">${title || 'File Preview'}</h3>
                            <p class="text-[10px] text-gray-500 uppercase tracking-wider font-bold">${ext.toUpperCase()} FILE</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 flex-shrink-0">
                        <a href="${url}" target="_blank" download class="text-xs font-bold text-indigo-600 bg-indigo-50 hover:bg-indigo-100 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition">
                            <i data-lucide="download" class="w-3.5 h-3.5"></i> Download
                        </a>
                        <a href="${url}" target="_blank" class="text-xs font-bold text-gray-600 bg-gray-100 hover:bg-gray-200 px-3 py-1.5 rounded-lg flex items-center gap-1.5 transition">
                            <i data-lucide="external-link" class="w-3.5 h-3.5"></i> Open
                        </a>
                        <button onclick="closeFilePreview()" class="text-gray-400 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-full p-1.5 transition">
                            <i data-lucide="x" class="w-5 h-5"></i>
                        </button>
                    </div>
                </div>
                <div class="flex-1 overflow-auto p-4 bg-gray-50">
                    ${previewContent}
                </div>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    lucide.createIcons();
};

window.closeFilePreview = function() {
    document.getElementById('file-preview-modal')?.remove();
};

// ==========================================
// ==========================================
// 📈 BUSINESS INTELLIGENCE ANALYTICS PAGE
// ==========================================
async function renderAnalytics(container) {
    container.innerHTML = renderLoadingState();
    const data = await window.db.getAnalyticsData();

    container.innerHTML = `
        <div class="max-w-7xl mx-auto space-y-6 animate-in pb-12">
            <div class="flex items-center justify-between flex-wrap gap-4">
                <div>
                    <h1 class="text-2xl font-extrabold tracking-tight">Business Intelligence Dashboard</h1>
                    <p class="text-sm text-gray-500 mt-1">Real-time performance analytics and pipeline optimization.</p>
                </div>
                <button onclick="exportAllCharts()" class="bg-indigo-600 hover:bg-indigo-700 text-white font-bold text-xs px-4 py-2.5 rounded-lg shadow-md flex items-center gap-2 transition">
                    <i data-lucide="download" class="w-4 h-4"></i> Export Intelligence Sheets
                </button>
            </div>

            <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <h3 class="font-bold text-gray-900 text-sm mb-4">Historical Revenue Trend</h3>
                    <div class="h-64 relative"><canvas id="chart-monthly-revenue"></canvas></div>
                </div>

                <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <h3 class="font-bold text-gray-900 text-sm mb-4">Logistics Distribution</h3>
                    <div class="h-64 relative"><canvas id="chart-dispatch-mode"></canvas></div>
                </div>

                <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <h3 class="font-bold text-gray-900 text-sm mb-4">Sales Representative Pipeline Values</h3>
                    <div class="h-64 relative"><canvas id="chart-sales-rep"></canvas></div>
                </div>

                <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
                    <h3 class="font-bold text-gray-900 text-sm mb-4">Top Accounts by Lifetime Value</h3>
                    <div class="h-64 relative"><canvas id="chart-top-customers"></canvas></div>
                </div>
            </div>
        </div>
    `;
    lucide.createIcons();

    // ─── INITIALIZE CHART LOGICS ──────────────────────────────────
    setTimeout(() => {
        // 1. Line Graph: Financial Growth
        new Chart(document.getElementById('chart-monthly-revenue'), {
            type: 'line',
            data: {
                labels: Object.keys(data.monthlyRevenue),
                datasets: [{ label: 'Revenue (₹)', data: Object.values(data.monthlyRevenue), borderColor: '#4f46e5', backgroundColor: '#4f46e510', tension: 0.3, fill: true }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });

        // 2. Doughnut Graph: Courier/Transport splits
        new Chart(document.getElementById('chart-dispatch-mode'), {
            type: 'doughnut',
            data: {
                labels: Object.keys(data.dispatchDistribution),
                datasets: [{ data: Object.values(data.dispatchDistribution), backgroundColor: ['#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#64748b'] }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });

        // 3. Bar Graph: Representative sales volumes
        const salesNames = Object.keys(data.salesPerformance);
        const salesValues = Object.values(data.salesPerformance).map(v => v.revenue);
        new Chart(document.getElementById('chart-sales-rep'), {
            type: 'bar',
            data: {
                labels: salesNames,
                datasets: [{ label: 'Pipeline Closed (₹)', data: salesValues, backgroundColor: '#8b5cf6', borderRadius: 6 }]
            },
            options: { responsive: true, maintainAspectRatio: false }
        });

        // 4. Horizontal Bar Graph: VIP Lifetime clients
        new Chart(document.getElementById('chart-top-customers'), {
            type: 'bar',
            data: {
                labels: data.topCustomers.map(c => c.name),
                datasets: [{ label: 'Lifetime Value (₹)', data: data.topCustomers.map(c => c.lifetime_value), backgroundColor: '#ec4899', borderRadius: 6 }]
            },
            options: { indexAxis: 'y', responsive: true, maintainAspectRatio: false }
        });
    }, 50);
}
window.handleSalesChange = function(selectEl) {
    const customInput = document.getElementById('no_sales_custom');
    if (selectEl.value === '__OTHER__') {
        customInput.style.display = 'block';
        customInput.required = true;
        customInput.focus();
    } else {
        customInput.style.display = 'none';
        customInput.required = false;
        customInput.value = '';
    }
};
// ==========================================
// ✏️ EDIT DISPATCH MODE
// ==========================================
window.editDispatchMode = function(orderId, currentMode) {
    const html = `
        <div id="edit-mode-modal" class="fixed inset-0 z-[70] flex items-center justify-center modal-backdrop p-4">
            <div class="bg-white rounded-2xl shadow-2xl w-full max-w-sm overflow-hidden border border-gray-100">
                <div class="p-5 border-b border-gray-100 bg-gray-50/50 flex justify-between items-center">
                    <h3 class="font-black text-lg text-gray-900">Change Dispatch Mode</h3>
                    <button onclick="document.getElementById('edit-mode-modal').remove()" class="text-gray-400 hover:text-gray-900 bg-gray-100 hover:bg-gray-200 rounded-full p-1.5">
                        <i data-lucide="x" class="w-5 h-5"></i>
                    </button>
                </div>
                <form onsubmit="saveDispatchMode(event, '${orderId}')" class="p-6">
                    <label class="block text-sm font-semibold text-gray-700 mb-2">Select New Mode *</label>
                    <select id="edit_mode_select" required class="w-full border border-gray-300 rounded-lg p-2.5 text-sm">
                        <option value="PORTER" ${currentMode === 'PORTER' ? 'selected' : ''}>🚚 PORTER</option>
                        <option value="SELF" ${currentMode === 'SELF' ? 'selected' : ''}>🚶 SELF</option>
                        <option value="DTDC" ${currentMode === 'DTDC' ? 'selected' : ''}>📦 DTDC</option>
                        <option value="DELIVERY" ${currentMode === 'DELIVERY' ? 'selected' : ''}>🛵 DELIVERY</option>
                        <option value="CARGO" ${currentMode === 'CARGO' ? 'selected' : ''}>🚛 CARGO</option>
                        <option value="BUS" ${currentMode === 'BUS' ? 'selected' : ''}>🚌 BUS</option>
                        <option value="TRACKON" ${currentMode === 'TRACKON' ? 'selected' : ''}>🚚 TRACKON</option>
                        <option value="OTHER" ${currentMode === 'OTHER' ? 'selected' : ''}>📌 OTHER</option>
                    </select>
                    <p class="text-[11px] text-gray-400 mt-2">Current: <strong>${currentMode || 'None'}</strong></p>
                    <div class="mt-6 flex justify-end gap-2">
                        <button type="button" onclick="document.getElementById('edit-mode-modal').remove()" class="px-4 py-2 text-sm font-bold text-gray-600 hover:bg-gray-100 rounded-lg">Cancel</button>
                        <button type="submit" id="save_mode_btn" class="px-5 py-2 text-sm font-bold text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow flex items-center gap-1.5">
                            <i data-lucide="check" class="w-4 h-4"></i> Save
                        </button>
                    </div>
                </form>
            </div>
        </div>`;
    document.body.insertAdjacentHTML('beforeend', html);
    lucide.createIcons();
};

window.saveDispatchMode = async function(e, orderId) {
    e.preventDefault();
    const btn = document.getElementById('save_mode_btn');
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i> Saving...`;
    lucide.createIcons();

    try {
        const newMode = document.getElementById('edit_mode_select').value;
        const { error } = await window.db.supabase
            .from('orders')
            .update({ dispatch_mode: newMode })
            .eq('id', orderId);
        
        if (error) throw error;

        document.getElementById('edit-mode-modal').remove();
        showToast(`Dispatch mode changed to ${newMode}`, 'success');
        openOrderDrawer(orderId);  // refresh drawer
    } catch (err) {
        showToast(err.message || 'Failed to update', 'error');
        btn.disabled = false;
        btn.innerHTML = `<i data-lucide="check" class="w-4 h-4"></i> Save`;
        lucide.createIcons();
    }
};

// Global scope export handler for chart sheets down to device memory
window.exportAllCharts = function() {
    showToast('Compiling analytical canvas assets...', 'info');
    document.querySelectorAll('canvas').forEach((canvas, i) => {
        const image = canvas.toDataURL("image/png").replace("image/png", "image/octet-stream");
        const link = document.createElement('a');
        link.download = `MMC-BI-Report-Chart-${i+1}.png`;
        link.href = image;
        link.click();
    });
    showToast('Analytics assets saved successfully!', 'success');
};
// --- GLOBAL AI CHALLAN PARSER ---
window.parseChallanWithAI = async function(file) {
    const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result.split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });

    const payload = {
        contents: [{
            parts: [
                { text: "You are a logistics assistant. Extract dispatch/challan details from this document. Return ONLY a valid JSON object with this exact structure: { \"customer_name\": \"Name of the buyer/consignee\", \"customer_phone\": \"Phone number if found, digits only\", \"order_value\": 1500.50, \"order_id\": \"Extract order number/ID if present, digits only\" } If a numeric value isn't found, use 0. If text isn't found, leave it blank. Do not include markdown or backticks." },
                { inlineData: { mimeType: file.type, data: base64 } }
            ]
        }]
    };

    // Calls the Vercel serverless function (api/gemini-proxy.js)
    const res = await fetch('/api/gemini-proxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || err.error || 'Backend Server Error');
    }

    const data = await res.json();
    let textResponse = data.candidates[0].content.parts[0].text;
    
    // Clean up formatting
    textResponse = textResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
    
    return JSON.parse(textResponse);
};
// ==========================================
// 📱 PWA — Register Service Worker
// ==========================================
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/service-worker.js')
            .then(reg => console.log('✅ SW registered:', reg.scope))
            .catch(err => console.log('❌ SW registration failed:', err));
    });
}
// ==========================================
// 🎤 VOICE NOTES — Web Speech API
// ==========================================

const VoiceNotes = {
    recognition: null,
    isRecording: false,
    targetTextarea: null,
    
    init() {
        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SpeechRecognition) {
            console.log('🎤 Speech recognition not supported on this browser');
            return false;
        }
        
        this.recognition = new SpeechRecognition();
        this.recognition.continuous = true;
        this.recognition.interimResults = true;
        this.recognition.lang = 'en-IN'; // Indian English
        
        this.recognition.onresult = (event) => {
            let transcript = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                transcript += event.results[i][0].transcript;
            }
            if (this.targetTextarea) {
                const existing = this.targetTextarea.dataset.preVoice || '';
                this.targetTextarea.value = existing + (existing ? ' ' : '') + transcript;
                this.targetTextarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        };
        
        this.recognition.onerror = (event) => {
            console.error('🎤 Speech error:', event.error);
            if (event.error === 'no-speech') {
                showToast('No speech detected. Try again.', 'warning');
            } else if (event.error === 'not-allowed') {
                showToast('Microphone permission denied', 'error');
            }
            this.stop();
        };
        
        this.recognition.onend = () => {
            if (this.isRecording) this.stop();
        };
        
        return true;
    },
    
    start(textarea, button) {
        if (!this.recognition) {
            if (!this.init()) {
                showToast('Voice notes not supported on this device', 'error');
                return;
            }
        }
        
        this.targetTextarea = textarea;
        this.targetTextarea.dataset.preVoice = textarea.value || '';
        this.isRecording = true;
        
        try {
            this.recognition.start();
            button.classList.add('voice-recording');
            button.innerHTML = '<i data-lucide="square" class="w-5 h-5"></i>';
            lucide.createIcons();
            showToast('🎤 Listening... tap again to stop', 'info');
            
            // Haptic feedback
            if (navigator.vibrate) navigator.vibrate(50);
        } catch (e) {
            console.error('Voice start error:', e);
        }
    },
    
    stop() {
        if (this.recognition && this.isRecording) {
            this.recognition.stop();
        }
        this.isRecording = false;
        
        document.querySelectorAll('.voice-recording').forEach(btn => {
            btn.classList.remove('voice-recording');
            btn.innerHTML = '<i data-lucide="mic" class="w-5 h-5"></i>';
        });
        if (window.lucide) lucide.createIcons();
        if (navigator.vibrate) navigator.vibrate([50, 50, 50]);
    },
    
    toggle(textarea, button) {
        if (this.isRecording) {
            this.stop();
        } else {
            this.start(textarea, button);
        }
    }
};

// Helper: attach voice button to any textarea
function attachVoiceButton(textarea) {
    if (!textarea || textarea.dataset.voiceAttached) return;
    textarea.dataset.voiceAttached = 'true';
    
    const wrapper = document.createElement('div');
    wrapper.style.position = 'relative';
    textarea.parentNode.insertBefore(wrapper, textarea);
    wrapper.appendChild(textarea);
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'voice-btn absolute right-2 top-2 p-2 rounded-full bg-indigo-100 hover:bg-indigo-200 text-indigo-600 transition-all z-10';
    btn.innerHTML = '<i data-lucide="mic" class="w-5 h-5"></i>';
    btn.title = 'Tap to dictate';
    btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        VoiceNotes.toggle(textarea, btn);
    };
    
    wrapper.appendChild(btn);
    
    // Add padding to textarea so text doesn't overlap button
    textarea.style.paddingRight = '50px';
    
    if (window.lucide) lucide.createIcons();
}

// Auto-attach voice buttons to all textareas after DOM updates
function refreshVoiceButtons() {
    document.querySelectorAll('textarea:not([data-voice-attached])').forEach(ta => {
        attachVoiceButton(ta);
    });
}

// Run on load + when drawer opens
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(refreshVoiceButtons, 1000);
});

// Refresh when content changes (use MutationObserver)
const voiceObserver = new MutationObserver(() => {
    refreshVoiceButtons();
});
voiceObserver.observe(document.body, { childList: true, subtree: true });
// ==========================================
// 🔄 PULL-TO-REFRESH (Mobile)
// ==========================================

const PullToRefresh = {
    startY: 0,
    currentY: 0,
    pulling: false,
    indicator: null,
    threshold: 80,
    container: null,
    
    init() {
        if (!isMobile()) return;
        
        // Create indicator
        this.indicator = document.createElement('div');
        this.indicator.id = 'pull-refresh-indicator';
        this.indicator.innerHTML = `
            <div class="ptr-spinner">
                <i data-lucide="refresh-cw" class="w-6 h-6"></i>
            </div>
            <span class="ptr-text">Pull to refresh</span>
        `;
        document.body.appendChild(this.indicator);
        if (window.lucide) lucide.createIcons();
        
        // Attach to body for global pull
        document.body.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
        document.body.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        document.body.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: true });
    },
    
    isMobileView() {
        return document.body.classList.contains('mobile-view') || window.innerWidth < 768;
    },
    
    onTouchStart(e) {
        // Only trigger if at top of page
        if (window.scrollY > 5) return;
        if (!this.isMobileView()) return;
        
        // Don't trigger if inside drawer/modal
        const insideOverlay = e.target.closest('.drawer, .modal-overlay, .pending-edit-modal');
        if (insideOverlay) return;
        
        this.startY = e.touches[0].clientY;
        this.pulling = true;
    },
    
    onTouchMove(e) {
        if (!this.pulling) return;
        
        this.currentY = e.touches[0].clientY;
        const distance = this.currentY - this.startY;
        
        if (distance > 0 && window.scrollY <= 5) {
            e.preventDefault();
            const progress = Math.min(distance / this.threshold, 1.5);
            const translateY = Math.min(distance * 0.5, 100);
            
            this.indicator.style.transform = `translateX(-50%) translateY(${translateY - 60}px)`;
            this.indicator.style.opacity = progress;
            
            if (progress >= 1) {
                this.indicator.classList.add('ready');
                this.indicator.querySelector('.ptr-text').textContent = 'Release to refresh';
            } else {
                this.indicator.classList.remove('ready');
                this.indicator.querySelector('.ptr-text').textContent = 'Pull to refresh';
            }
        }
    },
    
    onTouchEnd(e) {
        if (!this.pulling) return;
        this.pulling = false;
        
        const distance = this.currentY - this.startY;
        
        if (distance >= this.threshold && window.scrollY <= 5) {
            this.triggerRefresh();
        } else {
            this.reset();
        }
    },
    
    async triggerRefresh() {
        this.indicator.classList.add('refreshing');
        this.indicator.style.transform = 'translateX(-50%) translateY(20px)';
        this.indicator.style.opacity = '1';
        this.indicator.querySelector('.ptr-text').textContent = 'Refreshing...';
        
        if (navigator.vibrate) navigator.vibrate(50);
        
        try {
            // Reload orders data
            if (typeof loadOrders === 'function') {
                await loadOrders();
            } else {
                // Fallback - reload current view
                location.reload();
            }
            
            this.indicator.querySelector('.ptr-text').textContent = '✅ Updated';
            setTimeout(() => this.reset(), 800);
        } catch (e) {
            console.error('Refresh failed:', e);
            this.indicator.querySelector('.ptr-text').textContent = '❌ Failed';
            setTimeout(() => this.reset(), 1500);
        }
    },
    
    reset() {
        this.indicator.style.transform = 'translateX(-50%) translateY(-60px)';
        this.indicator.style.opacity = '0';
        this.indicator.classList.remove('ready', 'refreshing');
    }
};

// Init on load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => PullToRefresh.init(), 500);
});

// ==========================================
// GPS LOCATION CAPTURE
// ==========================================

const GPS = {
    cached: null,
    cacheTime: 0,
    cacheValidMs: 60000, // 1 minute cache

    async getCurrentLocation(useCache = true) {
        if (useCache && this.cached && (Date.now() - this.cacheTime < this.cacheValidMs)) {
            return this.cached;
        }

        return new Promise((resolve) => {
            if (!navigator.geolocation) { resolve(null); return; }

            navigator.geolocation.getCurrentPosition(
                (position) => {
                    const result = {
                        lat: position.coords.latitude,
                        lng: position.coords.longitude,
                        accuracy: position.coords.accuracy,
                        timestamp: position.timestamp
                    };
                    this.cached = result;
                    this.cacheTime = Date.now();
                    resolve(result);
                },
                (error) => {
                    console.log('GPS error:', error.message);
                    resolve(null);
                },
                { enableHighAccuracy: false, timeout: 5000, maximumAge: 60000 }
            );
        });
    },

    formatCoords(coords) {
        if (!coords) return null;
        return `${coords.lat.toFixed(6)}, ${coords.lng.toFixed(6)}`;
    },

    getMapsLink(coords) {
        if (!coords) return null;
        return `https://www.google.com/maps?q=${coords.lat},${coords.lng}`;
    }
};

// Pre-warm GPS cache silently on load
document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => GPS.getCurrentLocation(), 2000);
});

// ==========================================
// LIVE INDICATOR — reflects real-time push status, no polling timer
// ==========================================
function addAutoRefreshIndicator() {
    if (document.getElementById('auto-refresh-indicator')) return;
    const indicator = document.createElement('div');
    indicator.id = 'auto-refresh-indicator';
    indicator.innerHTML = '<span class="ar-dot"></span> Live';
    indicator.title = 'Updates arrive automatically — no manual refresh needed';
    document.body.appendChild(indicator);
}

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(addAutoRefreshIndicator, 3000);
});
