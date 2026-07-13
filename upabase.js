[1mdiff --git a/app.js b/app.js[m
[1mindex 3e8264b..44de707 100644[m
[1m--- a/app.js[m
[1m+++ b/app.js[m
[36m@@ -175,7 +175,7 @@[m [mfunction refreshCurrentView_() {[m
         renderMobileOrders(document.getElementById('main-content'));[m
     } else if (hash === '#/mobile/packing-queue') {[m
         renderPackingQueueMobile(document.getElementById('main-content'));[m
[31m-    } else if (['#/orders', '#/dashboard', '#/board', '#/packing-assignment'].includes(hash)) {[m
[32m+[m[32m    } else if (['#/orders', '#/dashboard', '#/board', '#/packing-assignment', '#/rickshaw-dispatch'].includes(hash)) {[m
         router();[m
     }[m
 }[m
[36m@@ -233,6 +233,7 @@[m [masync function router() {[m
                 await renderPackingAssignment(main);[m
             }[m
         }[m
[32m+[m[32m        else if (hash === '#/rickshaw-dispatch') await renderRickshawDispatch(main);[m
         else if (hash === '#/payment-status') await renderPaymentStatus(main);[m
         else if (hash === '#/mobile') await renderMobileHome(main);[m
         else if (hash === '#/mobile/orders') await renderMobileOrders(main);[m
[36m@@ -249,17 +250,21 @@[m [masync function router() {[m
 function renderSidebar() {[m
     const path = location.hash || '#/dashboard';[m
     const navItem = (href, icon, label, isActive) => `[m
[31m-        <a href="${href}" class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/10 transition-colors ${isActive ? 'bg-indigo-600 shadow-md text-white' : 'text-indigo-100'}">[m
[32m+[m[32m        <a href="${href}" onclick="closeSidebarMobile()" class="flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-white/10 transition-colors ${isActive ? 'bg-indigo-600 shadow-md text-white' : 'text-indigo-100'}">[m
             <i data-lucide="${icon}" class="w-5 h-5"></i> ${label}[m
         </a>`;[m
[31m-        [m
[32m+[m
     return `[m
[31m-        <aside class="w-64 sidebar-gradient text-white flex flex-col h-full hidden md:flex shadow-xl z-20">[m
[31m-            <div class="p-6 flex items-center gap-3 border-b border-white/10">[m
[31m-                <img src="/web-app-manifest-192x192.png" alt="Bansal Material House" class="w-10 h-10 rounded-lg">[m
[31m-                <h1 class="font-bold text-xl tracking-tight text-white">Bansal Material House Dispatch</h1>[m
[32m+[m[32m        <div id="sidebar-backdrop" class="hidden md:hidden fixed inset-0 bg-black/40 z-30" onclick="closeSidebarMobile()"></div>[m
[32m+[m[32m        <aside id="app-sidebar" class="w-64 sidebar-gradient text-white flex flex-col h-full shadow-xl z-40 fixed md:static inset-y-0 left-0 -translate-x-full md:translate-x-0 transition-transform duration-200 ease-out">[m
[32m+[m[32m            <div class="p-4 sm:p-6 flex items-center gap-3 border-b border-white/10">[m
[32m+[m[32m                <img src="/web-app-manifest-192x192.png" alt="Bansal Material House" class="w-10 h-10 rounded-lg flex-shrink-0">[m
[32m+[m[32m                <h1 class="font-bold text-lg sm:text-xl tracking-tight text-white leading-tight">Bansal Material House Dispatch</h1>[m
[32m+[m[32m                <button onclick="closeSidebarMobile()" class="md:hidden ml-auto flex-shrink-0 text-white/60 hover:text-white p-1 -mr-1" aria-label="Close menu">[m
[32m+[m[32m                    <i data-lucide="x" class="w-5 h-5"></i>[m
[32m+[m[32m                </button>[m
             </div>[m
[31m-            <nav class="flex-1 px-4 py-6 space-y-1.5">[m
[32m+[m[32m            <nav class="flex-1 px-4 py-6 space-y-1.5 overflow-y-auto">[m
                 <div class="text-[10px] text-white/40 font-bold uppercase tracking-wider mb-2 px-2">Workspace</div>[m
                 ${navItem('#/dashboard', 'layout-dashboard', t('dashboard'), path.includes('dashboard'))}[m
                 ${navItem('#/board', 'kanban', t('kanban'), path.includes('/board'))}[m
[36m@@ -267,11 +272,12 @@[m [mfunction renderSidebar() {[m
                 ${navItem('#/customers', 'users', 'Customers', path.includes('customers'))}[m
                 ${navItem('#/analytics', 'bar-chart-3', 'Analytics', path.includes('analytics'))}[m
                 ${['admin', 'manager'].includes(currentUser?.role) ? navItem('#/packing-assignment', 'clipboard-list', 'Packing Assignment', path.includes('packing-assignment')) : ''}[m
[32m+[m[32m                ${navItem('#/rickshaw-dispatch', 'bike', 'Rickshaw Dispatch', path.includes('rickshaw-dispatch'))}[m
                 ${navItem('#/payment-status', 'banknote', 'Payment Status', path.includes('payment-status'))}[m
             </nav>[m
             <div class="p-4 bg-black/20 backdrop-blur-sm m-4 rounded-xl border border-white/10">[m
                 <div class="flex items-center gap-3">[m
[31m-                    <div class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shadow-inner" style="background-color: ${currentUser?.avatar_color || '#4f46e5'}">[m
[32m+[m[32m                    <div class="w-10 h-10 rounded-full flex items-center justify-center text-sm font-bold text-white shadow-inner flex-shrink-0" style="background-color: ${currentUser?.avatar_color || '#4f46e5'}">[m
                         ${currentUser?.full_name?.substring(0,2).toUpperCase() || 'U'}[m
                     </div>[m
                     <div class="flex-1 min-w-0">[m
[36m@@ -284,12 +290,34 @@[m [mfunction renderSidebar() {[m
         </aside>`;[m
 }[m
 [m
[32m+[m[32m// Sidebar is fixed+off-canvas below md (768px) so it works as a "desktop[m
[32m+[m[32m// mode" overlay drawer on iPhone/iPad instead of the old `hidden md:flex`,[m
[32m+[m[32m// which made it disappear entirely on narrow forced-desktop screens.[m
[32m+[m[32mwindow.toggleSidebarMobile = function() {[m
[32m+[m[32m    const aside = document.getElementById('app-sidebar');[m
[32m+[m[32m    if (!aside) return;[m
[32m+[m[32m    aside.classList.contains('translate-x-0') ? closeSidebarMobile() : openSidebarMobile();[m
[32m+[m[32m};[m
[32m+[m
[32m+[m[32mwindow.openSidebarMobile = function() {[m
[32m+[m[32m    document.getElementById('app-sidebar')?.classList.replace('-translate-x-full', 'translate-x-0');[m
[32m+[m[32m    document.getElementById('sidebar-backdrop')?.classList.remove('hidden');[m
[32m+[m[32m};[m
[32m+[m
[32m+[m[32mwindow.closeSidebarMobile = function() {[m
[32m+[m[32m    document.getElementById('app-sidebar')?.classList.replace('translate-x-0', '-translate-x-full');[m
[32m+[m[32m    document.getElementById('sidebar-backdrop')?.classList.add('hidden');[m
[32m+[m[32m};[m
[32m+[m
 function renderTopbar() {[m
     const lang = localStorage.getItem('mmc_lang') || 'en';[m
     return `[m
[31m-        <header class="h-16 bg-white border-b border-gray-200 px-6 flex items-center justify-between sticky top-0 z-10 shadow-sm">[m
[31m-            <div class="flex items-center gap-4 flex-1">[m
[31m-                <div class="relative w-64 md:w-96">[m
[32m+[m[32m        <header class="min-h-16 bg-white border-b border-gray-200 px-3 sm:px-6 py-2 flex flex-wrap items-center justify-between gap-2 sm:gap-4 sticky top-0 z-10 shadow-sm">[m
[32m+[m[32m            <div class="flex items-center gap-2 flex-1 min-w-0">[m
[32m+[m[32m                <button onclick="toggleSidebarMobile()" class="md:hidden flex-shrink-0 -ml-1 p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition" aria-label="Open menu">[m
[32m+[m[32m                    <i data-lucide="menu" class="w-5 h-5"></i>[m
[32m+[m[32m                </button>[m
[32m+[m[32m                <div class="relative flex-1 min-w-[120px] sm:w-64 sm:flex-none md:w-96">[m
                     <i data-lucide="search" class="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400"></i>[m
                     <input type="text" id="global-search" placeholder="${t('search_placeholder')}"[m
                            oninput="handleGlobalSearch(event)"[m
[36m@@ -299,11 +327,11 @@[m [mfunction renderTopbar() {[m
                     <div id="search-dropdown" class="hidden absolute top-full left-0 right-0 mt-2 bg-white border border-gray-200 rounded-xl shadow-2xl max-h-96 overflow-y-auto z-50"></div>[m
                 </div>[m
             </div>[m
[31m-            <div class="flex items-center gap-3">[m
[31m-                <button onclick="toggleLanguage()" class="px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded-md text-sm font-semibold hover:bg-gray-200 transition">[m
[32m+[m[32m            <div class="flex items-center gap-2 sm:gap-3 flex-shrink-0">[m
[32m+[m[32m                <button onclick="toggleLanguage()" class="px-2.5 sm:px-3 py-1.5 bg-gray-100 text-gray-700 border border-gray-200 rounded-md text-xs sm:text-sm font-semibold hover:bg-gray-200 transition">[m
                     ${lang === 'hi' ? 'EN' : 'हिंदी'}[m
                 </button>[m
[31m-                <a href="#/orders/new" class="bg-indigo-600 text-white px-4 py-2 rounded-lg text-sm font-bold hover:bg-indigo-700 shadow-md shadow-indigo-600/20 flex items-center gap-2 transition-all hover:-translate-y-0.5">[m
[32m+[m[32m                <a href="#/orders/new" class="bg-indigo-600 text-white px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold hover:bg-indigo-700 shadow-md shadow-indigo-600/20 flex items-center gap-1.5 sm:gap-2 transition-all hover:-translate-y-0.5 whitespace-nowrap">[m
                     <i data-lucide="plus" class="w-4 h-4"></i> ${t('new_order')}[m
                 </a>[m
             </div>[m
[36m@@ -3314,6 +3342,8 @@[m [masync function renderPackingAssignment(container) {[m
                 <p class="text-sm text-gray-500 mt-1">Assign a packer and set priority for orders approaching the packing stage.</p>[m
             </div>[m
             <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">[m
[32m+[m[32m                <div class="overflow-x-auto">[m
[32m+[m[32m                <div class="min-w-[640px]">[m
                 <div class="grid grid-cols-12 gap-2 px-5 py-3 bg-gray-50 border-b border-gray-100 text-[11px] font-bold text-gray-500 uppercase tracking-wider">[m
                     <div class="col-span-3">Order</div>[m
                     <div class="col-span-3">Customer</div>[m
[36m@@ -3352,6 +3382,8 @@[m [masync function renderPackingAssignment(container) {[m
                         </div>[m
                     </div>[m
                 `).join('')}[m
[32m+[m[32m                </div>[m
[32m+[m[32m                </div>[m
             </div>[m
         </div>`;[m
 }[m
[36m@@ -3365,6 +3397,125 @@[m [mwindow.handlePackerAssign = async function(orderId, packerName, priority) {[m
     }[m
 };[m
 [m
[32m+[m[32m// ==========================================[m
[32m+[m[32m// RICKSHAW DISPATCH[m
[32m+[m[32m// ==========================================[m
[32m+[m[32mconst RICKSHAW_WALA_NAMES = ['Badri','Munna','Krishna','Nitesh','Rampukar','Praveen','Shankar','Sarwan','Nandu'];[m
[32m+[m
[32m+[m[32m// Cycled per distinct (rickshaw_wala + rickshaw_slot) trip group so orders[m
[32m+[m[32m// travelling together share an obvious visual tint, not just matching text.[m
[32m+[m[32mconst RICKSHAW_GROUP_COLORS = [[m
[32m+[m[32m    { bg: 'bg-amber-50',   border: 'border-amber-400',   text: 'text-amber-700',   dot: 'bg-amber-500' },[m
[32m+[m[32m    { bg: 'bg-emerald-50', border: 'border-emerald-400', text: 'text-emerald-700', dot: 'bg-emerald-500' },[m
[32m+[m[32m    { bg: 'bg-sky-50',     border: 'border-sky-400',     text: 'text-sky-700',     dot: 'bg-sky-500' },[m
[32m+[m[32m    { bg: 'bg-violet-50',  border: 'border-violet-400',  text: 'text-violet-700',  dot: 'bg-violet-500' },[m
[32m+[m[32m    { bg: 'bg-rose-50',    border: 'border-rose-400',    text: 'text-rose-700',    dot: 'bg-rose-500' },[m
[32m+[m[32m    { bg: 'bg-teal-50',    border: 'border-teal-400',    text: 'text-teal-700',    dot: 'bg-teal-500' },[m
[32m+[m[32m];[m
[32m+[m
[32m+[m[32masync function renderRickshawDispatch(container) {[m
[32m+[m[32m    container.innerHTML = renderLoadingState();[m
[32m+[m[32m    let orders;[m
[32m+[m[32m    try {[m
[32m+[m[32m        orders = await window.db.getOrdersForRickshawDispatch();[m
[32m+[m[32m    } catch (err) {[m
[32m+[m[32m        console.error(err);[m
[32m+[m[32m        container.innerHTML = `<div class="max-w-2xl mx-auto mt-10 p-6 bg-red-50 border border-red-200 rounded-xl text-red-700 text-sm">[m
[32m+[m[32m            <p class="font-bold mb-1">Couldn't load orders</p>[m
[32m+[m[32m            <p>${escapeHtml(err.message || 'Unknown error')}</p>[m
[32m+[m[32m            <p class="mt-2 text-xs text-red-500">This usually means the rickshaw_wala/rickshaw_location/rickshaw_slot migration hasn't been run in Supabase yet.</p>[m
[32m+[m[32m        </div>`;[m
[32m+[m[32m        return;[m
[32m+[m[32m    }[m
[32m+[m
[32m+[m[32m    // Orders sharing the same rickshaw_wala + rickshaw_slot (both set) travelled[m
[32m+[m[32m    // together in one trip — give each such group its own tint + badge.[m
[32m+[m[32m    const tripKey = o => (o.rickshaw_wala && o.rickshaw_slot) ? `${o.rickshaw_wala}__${o.rickshaw_slot}` : null;[m
[32m+[m[32m    const tripCounts = {};[m
[32m+[m[32m    orders.forEach(o => {[m
[32m+[m[32m        const key = tripKey(o);[m
[32m+[m[32m        if (key) tripCounts[key] = (tripCounts[key] || 0) + 1;[m
[32m+[m[32m    });[m
[32m+[m[32m    const tripColors = {};[m
[32m+[m[32m    let colorIdx = 0;[m
[32m+[m[32m    Object.keys(tripCounts).forEach(key => {[m
[32m+[m[32m        if (tripCounts[key] > 1) {[m
[32m+[m[32m            tripColors[key] = RICKSHAW_GROUP_COLORS[colorIdx % RICKSHAW_GROUP_COLORS.length];[m
[32m+[m[32m            colorIdx++;[m
[32m+[m[32m        }[m
[32m+[m[32m    });[m
[32m+[m
[32m+[m[32m    container.innerHTML = `[m
[32m+[m[32m        <div class="max-w-5xl mx-auto animate-in">[m
[32m+[m[32m            <div class="mb-6">[m
[32m+[m[32m                <h2 class="text-xl font-extrabold text-gray-900 tracking-tight">Rickshaw Dispatch</h2>[m
[32m+[m[32m                <p class="text-sm text-gray-500 mt-1">Assign a rickshaw driver, handoff location and trip slot. Orders sharing the same driver + slot travelled together in one trip — those are tinted and grouped below.</p>[m
[32m+[m[32m            </div>[m
[32m+[m[32m            <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">[m
[32m+[m[32m                <div class="overflow-x-auto">[m
[32m+[m[32m                <div class="min-w-[880px]">[m
[32m+[m[32m                <div class="grid grid-cols-12 gap-2 px-5 py-3 bg-gray-50 border-b border-gray-100 text-[11px] font-bold text-gray-500 uppercase tracking-wider">[m
[32m+[m[32m                    <div class="col-span-2">Order</div>[m
[32m+[m[32m                    <div class="col-span-2">Customer</div>[m
[32m+[m[32m                    <div class="col-span-2">Current Step</div>[m
[32m+[m[32m                    <div class="col-span-2">Rickshaw Wala</div>[m
[32m+[m[32m                    <div class="col-span-2">Location</div>[m
[32m+[m[32m                    <div class="col-span-2">Slot</div>[m
[32m+[m[32m                </div>[m
[32m+[m[32m                ${orders.length === 0 ? `<div class="p-10 text-center text-gray-400 text-sm">No active orders right now.</div>` : orders.map(o => {[m
[32m+[m[32m                    const key = tripKey(o);[m
[32m+[m[32m                    const color = key ? tripColors[key] : null;[m
[32m+[m[32m                    return `[m
[32m+[m[32m                    <div class="grid grid-cols-12 gap-2 px-5 py-3 border-b border-gray-50 items-center ${color ? `${color.bg} border-l-4 ${color.border}` : ''}" data-order-row="${o.id}">[m
[32m+[m[32m                        <div class="col-span-2">[m
[32m+[m[32m                            <p class="font-bold text-sm text-gray-900">${o.order_code}</p>[m
[32m+[m[32m                        </div>[m
[32m+[m[32m                        <div class="col-span-2 text-sm text-gray-700 truncate">${escapeHtml(o.customer_name)}</div>[m
[32m+[m[32m                        <div class="col-span-2">[m
[32m+[m[32m                            <span class="text-[11px] font-bold px-2 py-1 rounded bg-gray-100 text-gray-500">${o.current_step ? stepName(o.current_step) : '✓ Completed'}</span>[m
[32m+[m[32m                        </div>[m
[32m+[m[32m                        <div class="col-span-2">[m
[32m+[m[32m                            <select id="rw-wala-${o.id}" onchange="handleRickshawAssign('${o.id}')" class="w-full border border-gray-300 rounded-lg p-1.5 text-xs">[m
[32m+[m[32m                                <option value="" ${!o.rickshaw_wala ? 'selected' : ''}>Unassigned</option>[m
[32m+[m[32m                                ${RICKSHAW_WALA_NAMES.map(n => `<option value="${n}" ${o.rickshaw_wala === n ? 'selected' : ''}>${n}</option>`).join('')}[m
[32m+[m[32m                            </select>[m
[32m+[m[32m                        </div>[m
[32m+[m[32m                        <div class="col-span-2">[m
[32m+[m[32m                            <input id="rw-loc-${o.id}" type="text" value="${escapeHtml(o.rickshaw_location || '')}"[m
[32m+[m[32m                                onblur="handleRickshawAssign('${o.id}')" placeholder="e.g. Karol Bagh transporter"[m
[32m+[m[32m                                class="w-full border border-gray-300 rounded-lg p-1.5 text-xs">[m
[32m+[m[32m                        </div>[m
[32m+[m[32m                        <div class="col-span-2">[m
[32m+[m[32m                            <input id="rw-slot-${o.id}" type="text" value="${escapeHtml(o.rickshaw_slot || '')}"[m
[32m+[m[32m                                onblur="handleRickshawAssign('${o.id}')" placeholder="e.g. Slot 1 / Morning trip"[m
[32m+[m[32m                                class="w-full border border-gray-300 rounded-lg p-1.5 text-xs">[m
[32m+[m[32m                        </div>[m
[32m+[m[32m                        ${color ? `[m
[32m+[m[32m                        <div class="col-span-12 -mt-1 flex items-center gap-1.5">[m
[32m+[m[32m                            <span class="w-2 h-2 rounded-full ${color.dot} flex-shrink-0"></span>[m
[32m+[m[32m                            <span class="text-[11px] font-semibold ${color.text}">Travelling together — ${tripCounts[key]} orders in this trip</span>[m
[32m+[m[32m                        </div>` : ''}[m
[32m+[m[32m                    </div>[m
[32m+[m[32m                `; }).join('')}[m
[32m+[m[32m                </div>[m
[32m+[m[32m                </div>[m
[32m+[m[32m            </div>[m
[32m+[m[32m        </div>`;[m
[32m+[m[32m    lucide.createIcons();[m
[32m+[m[32m}[m
[32m+[m
[32m+[m[32mwindow.handleRickshawAssign = async function(orderId) {[m
[32m+[m[32m    const wala = document.getElementById(`rw-wala-${orderId}`)?.value || '';[m
[32m+[m[32m    const location = document.getElementById(`rw-loc-${orderId}`)?.value.trim() || '';[m
[32m+[m[32m    const slot = document.getElementById(`rw-slot-${orderId}`)?.value.trim() || '';[m
[32m+[m[32m    try {[m
[32m+[m[32m        await window.db.assignRickshawTrip(orderId, wala || null, location || null, slot || null);[m
[32m+[m[32m        showToast('Rickshaw dispatch updated', 'success');[m
[32m+[m[32m    } catch (err) {[m
[32m+[m[32m        showToast(err.message, 'error');[m
[32m+[m[32m    }[m
[32m+[m[32m};[m
[32m+[m
 // ==========================================[m
 // PAYMENT STATUS[m
 // ==========================================[m
[36m@@ -3390,6 +3541,7 @@[m [masync function renderPaymentStatus(container) {[m
     const renderTable = (list) => `[m
         <div class="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">[m
             ${list.length === 0 ? `<div class="p-8 text-center text-gray-400 text-sm">No orders here.</div>` : `[m
[32m+[m[32m            <div class="overflow-x-auto">[m
             <table class="w-full text-left text-sm whitespace-nowrap">[m
                 <thead class="bg-gray-50 text-gray-500 border-b border-gray-100">[m
                     <tr>[m
[36m@@ -3414,7 +3566,8 @@[m [masync function renderPaymentStatus(container) {[m
                             <td class="px-5 py-3">${paymentTermBadge(o.payment_term)}</td>[m
                         </tr>`).join('')}[m
                 </tbody>[m
[31m-            </table>`}[m
[32m+[m[32m            </table>[m
[32m+[m[32m            </div>`}[m
         </div>`;[m
 [m
     container.innerHTML = `[m
