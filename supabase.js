// ============================================================================
// SUPABASE CONFIGURATION & INITIALIZATION — BMH DISPATCH
// Adapted from DISPATCH-main/supabase.js. Sections unchanged from the
// original are left as-is because the new schema.sql's views were built to
// match them exactly (v_dashboard_kpis, v_step_breakdown, v_pending_tasks,
// v_top_performers all have identical column names to the MMC version).
//
// REMOVED vs MMC: pending_orders / acceptance_status / assigned_to workflow
// (getPendingOrders, getNewOrders, getMyAssignedOrders, acceptOrder,
// approvePendingOrder, rejectPendingOrder, updatePendingOrder) — BMH's
// schema has no such tables/columns, since STEP1 (order received) creates
// the order directly rather than landing in an approval queue. Add these
// back later if BMH ever needs a WhatsApp-bot-style intake queue.
// ============================================================================
const SUPABASE_URL = 'https://yoypuxathaxhbfbqhuwo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlveXB1eGF0aGF4aGJmYnFodXdvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM0OTI0ODAsImV4cCI6MjA5OTA2ODQ4MH0.YRwYptquEP8TYH_CSnfCWBkKUvpr31SGicriGMaFoE4';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

window.db = {
    supabase: supabaseClient,

    // ========================================================================
    // 1. AUTHENTICATION
    // ========================================================================

    async login(email, password) {
        return await supabaseClient.auth.signInWithPassword({ email, password });
    },

    async logout() {
        return await supabaseClient.auth.signOut();
    },

    async getSession() {
        const { data: { session } } = await supabaseClient.auth.getSession();
        return session;
    },

    async getCurrentUserExt() {
        const session = await this.getSession();
        if (!session) return null;

        const { data } = await supabaseClient
            .from('users')
            .select('*')
            .eq('id', session.user.id)
            .single();

        return data;
    },

    // ========================================================================
    // 2. USER & CUSTOMER REFERENCE DATA (unchanged from MMC)
    // ========================================================================

    async getCustomers() {
        const { data } = await supabaseClient.from('customers').select('*').order('name');
        return data || [];
    },

    async getAllCustomers() {
        return this.getCustomers();
    },

    async getSalesUsers() {
        const { data } = await supabaseClient
            .from('users')
            .select('*')
            .in('role', ['sales', 'admin', 'manager'])
            .eq('is_active', true);
        return data || [];
    },

    async getCustomerDetail(customerId) {
        const { data: customer } = await supabaseClient
            .from('customers').select('*').eq('id', customerId).single();

        const { data: orders } = await supabaseClient
            .from('orders')
            .select('id, order_code, order_value, created_at, current_step, is_delayed, is_completed')
            .eq('customer_id', customerId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        return { customer, orders: orders || [] };
    },

    async upsertCustomer(orgId, name, phone) {
        if (phone && phone.trim()) {
            const { data: byPhone } = await supabaseClient
                .from('customers').select('id')
                .eq('organization_id', orgId).eq('phone', phone.trim())
                .limit(1).maybeSingle();
            if (byPhone) return byPhone.id;
        }
        const { data: byName } = await supabaseClient
            .from('customers').select('id')
            .eq('organization_id', orgId).ilike('name', name)
            .limit(1).maybeSingle();
        if (byName) return byName.id;

        const { data, error } = await supabaseClient
            .from('customers')
            .insert([{ organization_id: orgId, name, phone: phone?.trim() || null }])
            .select('id').single();
        if (error) throw error;
        return data.id;
    },

    // ========================================================================
    // 3. DASHBOARD & ANALYTICS VIEWS (unchanged — view columns match schema.sql)
    // ========================================================================

    async getDashboardKPIs() {
        const { data } = await supabaseClient.from('v_dashboard_kpis').select('*').limit(1).maybeSingle();
        return data || { total_orders: 0, dispatched_today: 0, in_progress: 0, delayed_orders: 0 };
    },

    async getPipelineHealth() {
        const { data } = await supabaseClient.from('v_step_breakdown').select('*');
        return data || [];
    },

    async getCriticalDelays() {
        const { data } = await supabaseClient.from('v_pending_tasks').select('*').eq('is_delayed', true).limit(10);
        return data || [];
    },

    async getPendingTasks() {
        const { data } = await supabaseClient
            .from('v_pending_tasks').select('*')
            .order('delay_minutes', { ascending: false }).limit(15);
        return data || [];
    },

    async getTopPerformers() {
        const { data } = await supabaseClient.from('v_top_performers').select('*').limit(5);
        return data || [];
    },

    async getFinancialStats() {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('order_value, is_completed, completed_date')
            .eq('is_deleted', false);
        if (error) return { pipelineRevenue: 0, dispatchedToday: 0 };

        let pipeline = 0, dispatchedToday = 0;
        const todayStr = new Date().toISOString().split('T')[0];
        data.forEach(o => {
            if (!o.is_completed) pipeline += (o.order_value || 0);
            else if (o.completed_date && o.completed_date.startsWith(todayStr)) dispatchedToday += (o.order_value || 0);
        });
        return { pipelineRevenue: pipeline, dispatchedToday };
    },

    // ─── ANALYTICS DATA (for Analytics page charts) ───
    // Note: uses created_at (BMH schema) instead of MMC's order_date column.
    async getAnalyticsData() {
        const { data: orders } = await supabaseClient
            .from('orders')
            .select('order_value, created_at, dispatch_mode, sales_person_name, customer_id, is_completed, completed_date')
            .eq('is_deleted', false);

        const { data: topCust } = await supabaseClient
            .from('customers').select('name, lifetime_value, total_orders')
            .order('lifetime_value', { ascending: false }).limit(10);

        const monthlyRevenue = {};
        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            monthlyRevenue[`${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(-2)}`] = 0;
        }
        (orders || []).forEach(o => {
            if (!o.created_at) return;
            const d = new Date(o.created_at);
            const key = `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(-2)}`;
            if (monthlyRevenue[key] !== undefined) monthlyRevenue[key] += Number(o.order_value || 0);
        });

        const dispatchDistribution = {};
        (orders || []).forEach(o => {
            const mode = o.dispatch_mode || 'OTHER';
            dispatchDistribution[mode] = (dispatchDistribution[mode] || 0) + 1;
        });

        const salesPerformance = {};
        (orders || []).forEach(o => {
            const sp = o.sales_person_name || 'Unknown';
            if (!salesPerformance[sp]) salesPerformance[sp] = { revenue: 0, count: 0 };
            salesPerformance[sp].revenue += Number(o.order_value || 0);
            salesPerformance[sp].count += 1;
        });

        const topCustomers = (topCust || []).map(c => ({
            name: c.name, lifetime_value: c.lifetime_value || 0, total_orders: c.total_orders || 0
        }));

        return { monthlyRevenue, dispatchDistribution, salesPerformance, topCustomers };
    },

    async getLiveActivity() {
        const { data: subs, error } = await supabaseClient
            .from('step_submissions')
            .select('id, order_id, step_code, submitted_at, form_data')
            .order('submitted_at', { ascending: false }).limit(8);
        if (error || !subs) return [];

        const orderIds = [...new Set(subs.map(s => s.order_id).filter(Boolean))];
        const { data: orders } = orderIds.length > 0
            ? await supabaseClient.from('orders').select('id, order_code, customer_name').in('id', orderIds)
            : { data: [] };
        const ordersMap = {}; (orders || []).forEach(o => { ordersMap[o.id] = o; });

        const userIds = [...new Set(subs.map(s => s.form_data?.submitted_by).filter(Boolean))];
        const { data: users } = userIds.length > 0
            ? await supabaseClient.from('users').select('id, full_name, avatar_color').in('id', userIds)
            : { data: [] };
        const usersMap = {}; (users || []).forEach(u => { usersMap[u.id] = u; });

        return subs.map(s => ({
            id: s.id, step_code: s.step_code, submitted_at: s.submitted_at,
            orders: ordersMap[s.order_id] || null,
            users: usersMap[s.form_data?.submitted_by] || { full_name: 'System', avatar_color: '#64748b' }
        }));
    },

    // ========================================================================
    // 4. STEP DEFINITIONS — NEW. Frontend fetches these once and drives
    //    stepsDirectory / stepLabels dynamically instead of hardcoding.
    // ========================================================================

    async getStepDefinitions() {
        const { data, error } = await supabaseClient
            .from('step_definitions')
            .select('*')
            .eq('is_active', true)
            .order('sort_order');
        if (error) throw error;
        return data || [];
    },

    // ========================================================================
    // 5. KANBAN, ORDERS, & GLOBAL SEARCH (unchanged)
    // ========================================================================

    async getKanbanTasks() {
        const { data } = await supabaseClient.from('v_pending_tasks').select('*');
        return data || [];
    },

    async getOrders() {
        const { data } = await supabaseClient
            .from('orders').select('*').eq('is_deleted', false).order('created_at', { ascending: false });
        return data || [];
    },

    async globalSearch(query) {
        const safeQuery = query.replace(/,/g, ' ').trim();
        const q = `%${safeQuery}%`;
        const [{ data: orders, error: errOrders }, { data: customers, error: errCust }] = await Promise.all([
            supabaseClient.from('orders').select('*')
                .or(`order_code.ilike.${q},customer_name.ilike.${q},customer_phone.ilike.${q}`).limit(8),
            supabaseClient.from('customers').select('*').or(`name.ilike.${q},phone.ilike.${q}`).limit(5)
        ]);
        if (errOrders) console.error('Order Search Error:', errOrders.message);
        if (errCust) console.error('Customer Search Error:', errCust.message);
        return { orders: orders || [], customers: customers || [] };
    },

    async getOrderDetail(id) {
        const { data: order, error: orderErr } = await supabaseClient.from('orders').select('*').eq('id', id).single();
        if (orderErr) console.error('getOrderDetail order:', orderErr);
        const { data: steps, error: stepsErr } = await supabaseClient
            .from('order_step_status').select('*').eq('order_id', id);
        if (stepsErr) console.error('getOrderDetail steps:', stepsErr);
        return { order, steps: steps || [] };
    },

    async getOrderSubmissions(orderId) {
        const { data } = await supabaseClient
            .from('step_submissions').select('*').eq('order_id', orderId).order('submitted_at', { ascending: false });
        return data || [];
    },

    // ========================================================================
    // 6. ORDER CREATION — now a thin wrapper around the create_order RPC.
    //    All order-code generation + step seeding happens server-side.
    // ========================================================================

    async createOrder({
        organizationId, customerId, customerName, customerPhone, customerPhone2, contactPerson,
        city, state, paymentType, bankName, dispatchMode, salesPersonName, orderValue, paymentTerm
    }) {
        const { data, error } = await supabaseClient.rpc('create_order', {
            p_organization_id: organizationId,
            p_customer_id: customerId || null,
            p_customer_name: customerName,
            p_customer_phone: customerPhone || null,
            p_customer_phone_2: customerPhone2 || null,
            p_contact_person: contactPerson || null,
            p_city: city || null,
            p_state: state || null,
            p_payment_type: paymentType,
            p_bank_name: bankName || null,
            p_dispatch_mode: dispatchMode,
            p_sales_person_name: salesPersonName || null,
            p_order_value: orderValue ?? null,
            p_payment_term: paymentTerm || null
        });
        if (error) throw error;
        return data;
    },

    // Attaches an optional PI/order document as evidence on STEP1, without
    // going through the submit_step RPC — STEP1 is already DONE at creation,
    // and re-running submit_step would incorrectly re-anchor STEP2's
    // planned_at off "now" instead of leaving the original cascaded seed
    // value from create_order intact.
    async attachStep1Evidence(orderId, fileUrl, userId) {
        const { error } = await supabaseClient
            .from('step_submissions')
            .insert([{
                order_id: orderId,
                step_code: 'STEP1_ORDER_RECEIVED',
                form_data: { file_url: fileUrl, submitted_by: userId, submitted_at: new Date().toISOString() },
                is_latest: true
            }]);
        if (error) throw error;
    },

    async createShareToken(orderId, organizationId) {
        const { data: existing } = await supabaseClient
            .from('public_share_tokens').select('token')
            .eq('order_id', orderId).eq('is_revoked', false).limit(1).maybeSingle();
        if (existing) return existing.token;

        const token = (crypto.randomUUID().replace(/-/g, '') + Math.random().toString(36).substring(2, 10));
        const { data, error } = await supabaseClient
            .from('public_share_tokens')
            .insert([{
                token, order_id: orderId, organization_id: organizationId,
                created_by: (await this.getSession())?.user?.id, expires_at: null
            }])
            .select('token').single();
        if (error) throw error;
        return data.token;
    },

    // ─── PACKING ASSIGNMENT ───
    // Orders approaching/at the packing stage, for the admin assignment page.
    async getOrdersForPackingAssignment() {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('*')
            .in('current_step', ['STEP4_SENT_TO_PACKING', 'STEP5_PACKING_DONE'])
            .eq('is_deleted', false).eq('is_cancelled', false)
            .order('packing_priority', { ascending: true, nullsFirst: false });
        if (error) { console.error('getOrdersForPackingAssignment:', error); throw error; }
        return data || [];
    },

    // ─── PAYMENT STATUS ───
    // Active orders with a payment_term set, for the Payment Status page —
    // split into ADVANCE ("paid, prioritize") vs CREDIT ("pending") client-side.
    async getOrdersByPaymentTerm() {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('is_deleted', false).eq('is_cancelled', false).eq('is_completed', false)
            .not('payment_term', 'is', null)
            .order('created_at', { ascending: true });
        if (error) { console.error('getOrdersByPaymentTerm:', error); throw error; }
        return data || [];
    },

    async assignPacker(orderId, packerName, priority) {
        const { error } = await supabaseClient
            .from('orders')
            .update({ assigned_packer: packerName || null, packing_priority: priority ?? null })
            .eq('id', orderId);
        if (error) throw error;
    },

    // ─── RICKSHAW DISPATCH ───
    // Active orders, for the rickshaw driver/handoff assignment page.
    // Excludes orders already marked reached — that's what "closes" an
    // order out of this page once the rickshaw has handed it off.
    async getOrdersForRickshawDispatch() {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('is_deleted', false).eq('is_cancelled', false).eq('is_completed', false)
            .is('rickshaw_reached_at', null)
            .order('created_at', { ascending: true });
        if (error) { console.error('getOrdersForRickshawDispatch:', error); throw error; }
        return data || [];
    },

    async assignRickshawTrip(orderId, rickshawWala, location, slot) {
        const { error } = await supabaseClient
            .from('orders')
            .update({ rickshaw_wala: rickshawWala || null, rickshaw_location: location || null, rickshaw_slot: slot || null })
            .eq('id', orderId);
        if (error) throw error;
    },

    async markRickshawReached(orderId) {
        const { error } = await supabaseClient
            .from('orders')
            .update({ rickshaw_reached_at: new Date().toISOString() })
            .eq('id', orderId);
        if (error) throw error;
    },

    // Mobile packing queue: assigned + not yet accepted, sorted by priority.
    async getPackingQueue() {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('current_step', 'STEP5_PACKING_DONE')
            .not('assigned_packer', 'is', null)
            .is('packing_accepted_at', null)
            .eq('is_deleted', false).eq('is_cancelled', false)
            .order('packing_priority', { ascending: true, nullsFirst: false });
        if (error) { console.error('getPackingQueue:', error); throw error; }
        return data || [];
    },

    // Accepted, in-progress packing orders for the current device/user.
    async getAcceptedPackingOrders() {
        const { data, error } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('current_step', 'STEP5_PACKING_DONE')
            .not('packing_accepted_at', 'is', null)
            .eq('is_deleted', false).eq('is_cancelled', false)
            .order('packing_accepted_at', { ascending: true });
        if (error) { console.error('getAcceptedPackingOrders:', error); throw error; }
        return data || [];
    },

    async acceptPackingOrder(orderId, userId) {
        const { error } = await supabaseClient
            .from('orders')
            .update({ packing_accepted_at: new Date().toISOString(), packing_accepted_by: userId })
            .eq('id', orderId);
        if (error) throw error;
    },

    // Fetch the Performa Invoice proof (STEP2) so packers can see what to pack.
    async getPISubmission(orderId) {
        const { data } = await supabaseClient
            .from('step_submissions')
            .select('form_data')
            .eq('order_id', orderId).eq('step_code', 'STEP2_PI_CREATED').eq('is_latest', true)
            .maybeSingle();
        return data?.form_data || null;
    },

    async cancelOrder(orderId, reason) {
        const session = await this.getSession();
        const { error } = await supabaseClient
            .from('orders')
            .update({
                is_cancelled: true, cancelled_at: new Date().toISOString(),
                cancelled_by: session?.user?.id, cancellation_reason: reason || null,
                current_step: null
            })
            .eq('id', orderId);
        if (error) throw error;
    },

    async restoreOrder(orderId) {
        const { error } = await supabaseClient
            .from('orders')
            .update({ is_cancelled: false, cancelled_at: null, cancelled_by: null, cancellation_reason: null })
            .eq('id', orderId);
        if (error) throw error;
        await supabaseClient.rpc('refresh_order_status', { p_order_id: orderId });
    },

    // ========================================================================
    // 7. FILE UPLOAD & STEP SUBMISSION
    //    Single bucket 'bmh-proofs' for every step (PI/PAYMENT/SENT/PACKING/
    //    TRANSPORT/LR) — matches schema.sql's storage policies.
    // ========================================================================

    async uploadFile(bucket, file) {
        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;

        const { error } = await supabaseClient.storage
            .from(bucket)
            .upload(fileName, file, { cacheControl: '3600', upsert: false, contentType: file.type });
        if (error) throw new Error(`Upload failed: ${error.message}`);

        const { data: urlData } = supabaseClient.storage.from(bucket).getPublicUrl(fileName);
        return urlData.publicUrl;
    },

    // Now a thin wrapper around the submit_step RPC — the RPC handles
    // marking DONE, re-anchoring the next step's planned_at, and refreshing
    // order status, all atomically server-side (see schema.sql).
    async submitStep(orderId, stepCode, formDataJson) {
        const { error } = await supabaseClient.rpc('submit_step', {
            p_order_id: orderId,
            p_step_code: stepCode,
            p_form_data: formDataJson
        });
        if (error) throw error;
    },
};
