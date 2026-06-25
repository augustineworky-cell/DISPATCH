// ============================================================================
// SUPABASE CONFIGURATION & INITIALIZATION
// ============================================================================
const SUPABASE_URL = 'https://cuhjtpznjewhuummnxnz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImN1aGp0cHpuamV3aHV1bW1ueG56Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwMDQ3MjksImV4cCI6MjA5NDU4MDcyOX0.DoeI1G9JJAMo69w4QWsYk8QiRQGjTPI3jdFsS7PUaoc';

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
    // 2. USER & CUSTOMER REFERENCE DATA
    // ========================================================================
    
    async getCustomers() {
        const { data } = await supabaseClient
            .from('customers')
            .select('*')
            .order('name');
        return data || [];
    },
    
    async getAllCustomers() {
        const { data } = await supabaseClient
            .from('customers')
            .select('*')
            .order('name');
        return data || [];
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
            .from('customers')
            .select('*')
            .eq('id', customerId)
            .single();
            
        const { data: orders } = await supabaseClient
            .from('orders')
            .select('id, order_code, order_value, order_date, current_step, is_delayed, is_completed')
            .eq('customer_id', customerId)
            .eq('is_deleted', false)
            .order('order_date', { ascending: false });
            
        return { customer, orders: orders || [] };
    },

    async upsertCustomer(orgId, name, phone) {
        // 1. Try to find by phone first (most reliable identifier)
        if (phone && phone.trim()) {
            const { data: byPhone } = await supabaseClient
                .from('customers')
                .select('id')
                .eq('organization_id', orgId)
                .eq('phone', phone.trim())
                .limit(1)
                .maybeSingle();
            if (byPhone) return byPhone.id;
        }

        // 2. Otherwise find by name (case-insensitive)
        const { data: byName } = await supabaseClient
            .from('customers')
            .select('id')
            .eq('organization_id', orgId)
            .ilike('name', name)
            .limit(1)
            .maybeSingle();
        if (byName) return byName.id;

        // 3. Create new customer
        const { data, error } = await supabaseClient
            .from('customers')
            .insert([{ 
                organization_id: orgId, 
                name, 
                phone: phone?.trim() || null 
            }])
            .select('id')
            .single();
            
        if (error) throw error;
        return data.id;
    },

    // ========================================================================
    // 3. DASHBOARD & ANALYTICS VIEWS
    // ========================================================================
    
    async getDashboardKPIs() {
        const { data } = await supabaseClient
            .from('v_dashboard_kpis')
            .select('*')
            .limit(1)
            .maybeSingle();
        return data || { total_orders: 0, dispatched_today: 0, in_progress: 0, delayed_orders: 0 };
    },
    
    async getPipelineHealth() {
        const { data } = await supabaseClient
            .from('v_step_breakdown')
            .select('*');
        return data || [];
    },
    
    async getCriticalDelays() {
        const { data } = await supabaseClient
            .from('v_pending_tasks')
            .select('*')
            .eq('is_delayed', true)
            .limit(10);
        return data || [];
    },

    async getPendingTasks() {
        // Gets all actionable tasks, sorted by urgency (highest delay first)
        const { data } = await supabaseClient
            .from('v_pending_tasks')
            .select('*')
            .order('delay_minutes', { ascending: false })
            .limit(15);
        return data || [];
    },

    async getFinancialStats() {
        // Fetch orders to calculate real-time pipeline value
        const { data, error } = await supabaseClient
            .from('orders')
            .select('order_value, is_completed, completed_date')
            .eq('is_deleted', false);
            
        if (error) return { pipelineRevenue: 0, dispatchedToday: 0 };
        
        let pipeline = 0;
        let dispatchedToday = 0;
        const todayStr = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
        
        data.forEach(o => {
            if (!o.is_completed) {
                pipeline += (o.order_value || 0);
            } else if (o.completed_date && o.completed_date.startsWith(todayStr)) {
                dispatchedToday += (o.order_value || 0);
            }
        });
        
        return { pipelineRevenue: pipeline, dispatchedToday };
    },

async getLiveActivity() {
        // Fetch recent submissions (no FK joins — fetch related data separately)
        const { data: subs, error } = await supabaseClient
            .from('step_submissions')
            .select('id, order_id, step_code, submitted_at, form_data')
            .order('submitted_at', { ascending: false })
            .limit(8);
        
        if (error || !subs) {
            console.error("Activity Error:", error);
            return [];
        }

        // Manually fetch order codes
        const orderIds = [...new Set(subs.map(s => s.order_id).filter(Boolean))];
        const { data: orders } = orderIds.length > 0 ? await supabaseClient
            .from('orders')
            .select('id, order_code, customer_name')
            .in('id', orderIds) : { data: [] };
        
        const ordersMap = {};
        (orders || []).forEach(o => { ordersMap[o.id] = o; });

        // Manually fetch user names from submitted_by in form_data
        const userIds = [...new Set(subs.map(s => s.form_data?.submitted_by).filter(Boolean))];
        const { data: users } = userIds.length > 0 ? await supabaseClient
            .from('users')
            .select('id, full_name, avatar_color')
            .in('id', userIds) : { data: [] };
        
        const usersMap = {};
        (users || []).forEach(u => { usersMap[u.id] = u; });

        // Combine
        return subs.map(s => ({
            id: s.id,
            step_code: s.step_code,
            submitted_at: s.submitted_at,
            orders: ordersMap[s.order_id] || null,
            users: usersMap[s.form_data?.submitted_by] || { full_name: 'System', avatar_color: '#64748b' }
        }));
    },
    
    async getTopPerformers() {
        const { data } = await supabaseClient
            .from('v_top_performers')
            .select('*')
            .limit(5);
        return data || [];
    },
    // ─── ANALYTICS DATA (for Analytics page charts) ───
    async getAnalyticsData() {
        // Fetch all orders for aggregation
        const { data: orders } = await supabaseClient
            .from('orders')
            .select('order_value, order_date, dispatch_mode, sales_person_name, customer_id, is_completed, completed_date')
            .eq('is_deleted', false);

        const { data: topCust } = await supabaseClient
            .from('customers')
            .select('name, lifetime_value, total_orders')
            .order('lifetime_value', { ascending: false })
            .limit(10);

        // Monthly revenue (last 12 months)
        const monthlyRevenue = {};
        const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const now = new Date();
        for (let i = 11; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            const key = `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(-2)}`;
            monthlyRevenue[key] = 0;
        }
        (orders || []).forEach(o => {
            if (!o.order_date) return;
            const d = new Date(o.order_date);
            const key = `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(-2)}`;
            if (monthlyRevenue[key] !== undefined) {
                monthlyRevenue[key] += Number(o.order_value || 0);
            }
        });

        // Dispatch mode distribution
        const dispatchDistribution = {};
        (orders || []).forEach(o => {
            const mode = o.dispatch_mode || 'OTHER';
            dispatchDistribution[mode] = (dispatchDistribution[mode] || 0) + 1;
        });

        // Sales performance
        const salesPerformance = {};
        (orders || []).forEach(o => {
            const sp = o.sales_person_name || 'Unknown';
            if (!salesPerformance[sp]) salesPerformance[sp] = { revenue: 0, count: 0 };
            salesPerformance[sp].revenue += Number(o.order_value || 0);
            salesPerformance[sp].count += 1;
        });

        // Top customers (already fetched, but format)
        const topCustomers = (topCust || []).map(c => ({
            name: c.name,
            lifetime_value: c.lifetime_value || 0,
            total_orders: c.total_orders || 0
        }));

        return {
            monthlyRevenue,
            dispatchDistribution,
            salesPerformance,
            topCustomers
        };
    },

    // ========================================================================
    // 4. KANBAN, ORDERS, & GLOBAL SEARCH
    // ========================================================================
    
    async getKanbanTasks() {
        const { data } = await supabaseClient
            .from('v_pending_tasks')
            .select('*');
        return data || [];
    },
    
    async getOrders() {
        const { data } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });
        return data || [];
    },

    async globalSearch(query) {
        // Strip commas to prevent breaking the Supabase search syntax
        const safeQuery = query.replace(/,/g, ' ').trim();
        const q = `%${safeQuery}%`;

        const [
            { data: orders, error: errOrders }, 
            { data: customers, error: errCust }
        ] = await Promise.all([
            supabaseClient.from('orders')
                .select('*')
                .or(`order_code.ilike.${q},customer_name.ilike.${q},customer_phone.ilike.${q}`)
                .limit(8),
            supabaseClient.from('customers')
                .select('*')
                .or(`name.ilike.${q},phone.ilike.${q}`)
                .limit(5)
        ]);

        // Log errors to prevent silent failures
        if (errOrders) console.error("Order Search Error:", errOrders.message);
        if (errCust) console.error("Customer Search Error:", errCust.message);

        return { orders: orders || [], customers: customers || [] };
    },

    async getOrderDetail(id) {
        const { data: order, error: orderErr } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('id', id)
            .single();
            
        if (orderErr) console.error('getOrderDetail order:', orderErr);

        const { data: steps, error: stepsErr } = await supabaseClient
            .from('order_step_status')
            .select('*')
            .eq('order_id', id);
            
        if (stepsErr) console.error('getOrderDetail steps:', stepsErr);

        return { order, steps: steps || [] };
    },

    async getOrderSubmissions(orderId) {
        const { data } = await supabaseClient
            .from('step_submissions')
            .select('*')
            .eq('order_id', orderId)
            .order('submitted_at', { ascending: false });
        return data || [];
    },

    // ========================================================================
    // 5. ORDER CREATION & WORKFLOWS
    // ========================================================================
    
    async createShareToken(orderId) {
        // Check if active token already exists (reuse instead of creating duplicates)
        const { data: existing } = await supabaseClient
            .from('public_share_tokens')
            .select('token')
            .eq('order_id', orderId)
            .eq('is_revoked', false)
            .limit(1)
            .maybeSingle();

        if (existing) return existing.token;

        // Generate cryptographically random token
        const token = (crypto.randomUUID().replace(/-/g, '') + Math.random().toString(36).substring(2, 10));

        const { data, error } = await supabaseClient
            .from('public_share_tokens')
            .insert([{
                token,
                order_id: orderId,
                organization_id: currentOrgId,
                created_by: (await this.getSession())?.user?.id,
                expires_at: null  // Admin can revoke from settings later
            }])
            .select('token')
            .single();
            
        if (error) throw error;
        return data.token;
    },

    async createOrder(orderData) {
        // Generates order_code: Tries trigger first, then falls back to JS-side generation
        let attemptedCode = null;

        try {
            // Attempt 1: Let DB trigger generate the code
            const { data, error } = await supabaseClient
                .from('orders')
                .insert([orderData])
                .select()
                .single();
            
            if (error) {
                // Trigger failed — fall back to JS-side generation
                if (error.code === '23502' && error.message.includes('order_code')) {
                    console.warn('DB trigger failed, generating order_code in JS...');
                    attemptedCode = await this._generateOrderCodeManually(orderData.organization_id);
                    orderData.order_code = attemptedCode.code;
                    orderData.order_number = attemptedCode.number;

                    const { data: dataFallback, error: errorFallback } = await supabaseClient
                        .from('orders')
                        .insert([orderData])
                        .select()
                        .single();
                        
                    if (errorFallback) throw errorFallback;
                    
                    await this._createStepStatuses(dataFallback.id, dataFallback.created_at);
                    return dataFallback;
                }
                throw error;
            }

            await this._createStepStatuses(data.id, data.created_at);
            return data;
            
        } catch (err) {
            console.error('createOrder failed:', err);
            throw err;
        }
    },

    // Helper: Manually generate order code (fallback only)
    async _generateOrderCodeManually(orgId) {
        const { data: org, error } = await supabaseClient
            .from('organizations')
            .select('order_id_prefix, order_id_next')
            .eq('id', orgId)
            .single();
            
        if (error) throw error;

        const code = `${org.order_id_prefix}-${org.order_id_next}`;
        const number = org.order_id_next;

        // Increment counter for next order
        await supabaseClient
            .from('organizations')
            .update({ order_id_next: org.order_id_next + 1 })
            .eq('id', orgId);

        return { code, number };
    },

    // Helper: Create 6 step status rows for a new order
    async _createStepStatuses(orderId, createdAt) {
        const now = new Date(createdAt || Date.now());
        const stepInserts = [
            { order_id: orderId, step_code: 'STEP2_EMAIL_PRODUCTION',  status: 'PENDING', planned_at: new Date(now.getTime() + 1  * 3600000).toISOString() },
            { order_id: orderId, step_code: 'STEP3_STOCK_UPDATE',      status: 'PENDING', planned_at: new Date(now.getTime() + 4  * 3600000).toISOString() },
            { order_id: orderId, step_code: 'STEP4_PDI_CHECKLIST',     status: 'PENDING', planned_at: new Date(now.getTime() + 24 * 3600000).toISOString() },
            { order_id: orderId, step_code: 'STEP5_VIDEO_CUSTOMER',    status: 'PENDING', planned_at: new Date(now.getTime() + 28 * 3600000).toISOString() },
            { order_id: orderId, step_code: 'STEP6_TRANSPORT_CHARGES', status: 'PENDING', planned_at: new Date(now.getTime() + 32 * 3600000).toISOString() },
            { order_id: orderId, step_code: 'STEP7_DISPATCH_TRACKING', status: 'PENDING', planned_at: new Date(now.getTime() + 48 * 3600000).toISOString() }
        ];
        
        const { error } = await supabaseClient.from('order_step_status').insert(stepInserts);
        if (error) console.error('Step inserts failed:', error);
    },

    // ========================================================================
    // 6. FILE UPLOAD & SUBMISSIONS
    // ========================================================================
    
    async uploadFile(bucket, file) {
        console.log('📤 [uploadFile] Starting upload', { 
            bucket, 
            fileName: file.name, 
            fileSize: file.size, 
            fileType: file.type 
        });

        const fileExt = file.name.split('.').pop();
        const fileName = `${Date.now()}-${Math.random().toString(36).substring(7)}.${fileExt}`;
        
        console.log('📤 [uploadFile] Uploading to', { bucket, path: fileName });

        const { data, error } = await supabaseClient.storage
            .from(bucket)
            .upload(fileName, file, {
                cacheControl: '3600',
                upsert: false,
                contentType: file.type
            });

        if (error) {
            console.error('❌ [uploadFile] UPLOAD FAILED:', error);
            console.error('Full error object:', JSON.stringify(error, null, 2));
            throw new Error(`Upload failed: ${error.message}`);
        }

        console.log('✅ [uploadFile] Upload successful:', data);

        const { data: urlData } = supabaseClient.storage
            .from(bucket)
            .getPublicUrl(fileName);

        console.log('🔗 [uploadFile] Public URL:', urlData.publicUrl);

        // Verify the file actually exists by HEAD request
        try {
            const verifyResp = await fetch(urlData.publicUrl, { method: 'HEAD' });
            console.log('🔍 [uploadFile] Verification HEAD request:', {
                url: urlData.publicUrl,
                status: verifyResp.status,
                ok: verifyResp.ok
            });
            if (!verifyResp.ok) {
                console.error('⚠️ [uploadFile] FILE NOT ACCESSIBLE at URL despite no upload error!');
            }
        } catch (e) {
            console.warn('Could not verify file access:', e);
        }

        return urlData.publicUrl;
    },

    async submitStep(orderId, stepCode, formDataJson) {
        // Mark older submissions as not latest
        await supabaseClient
            .from('step_submissions')
            .update({ is_latest: false })
            .eq('order_id', orderId)
            .eq('step_code', stepCode);

        // Insert new submission
        const { data: submission, error: subErr } = await supabaseClient
            .from('step_submissions')
            .insert([{
                order_id: orderId,
                step_code: stepCode,
                form_data: formDataJson,
                is_latest: true
            }])
            .select()
            .single();
            
        if (subErr) throw subErr;

        // Update step status
        const { error: statErr } = await supabaseClient
            .from('order_step_status')
            .update({ status: 'DONE', actual_at: new Date().toISOString() })
            .eq('order_id', orderId)
            .eq('step_code', stepCode);
            
        if (statErr) throw statErr;

        // Refresh order's current_step + is_delayed + is_completed
        await supabaseClient.rpc('refresh_order_status', { p_order_id: orderId });
        
        return submission;
    },

    // ─── PENDING ORDERS ───
    async getPendingOrders() {
        const { data } = await supabaseClient
            .from('pending_orders')
            .select('*')
            .eq('status', 'PENDING')
            .order('received_at', { ascending: false });
        return data || [];
    },

    // ─── ORDER ASSIGNMENT ───
    async getNewOrders() {
        const { data } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('is_deleted', false)
            .eq('acceptance_status', 'NEW')
            .order('created_at', { ascending: false });
        return data || [];
    },

    async getMyAssignedOrders(userId) {
        const { data } = await supabaseClient
            .from('orders')
            .select('*')
            .eq('is_deleted', false)
            .eq('assigned_to', userId)
            .eq('acceptance_status', 'ACCEPTED')
            .order('created_at', { ascending: false });
        return data || [];
    },

    async acceptOrder(orderId, userId) {
        const { data, error } = await supabaseClient.rpc('accept_order', {
            p_order_id: orderId,
            p_user_id: userId
        });
        if (error) throw error;
        return data;
    },

    async approvePendingOrder(pendingId) {
        // 1. Get pending order data
        const { data: pending, error: e1 } = await supabaseClient
            .from('pending_orders').select('*').eq('id', pendingId).single();
        if (e1) throw e1;

        // 2. Upsert customer
        const customerId = await this.upsertCustomer(
            pending.organization_id,
            pending.customer_name,
            pending.customer_phone
        );

        // 3. Get next order number
        const { data: orderNum } = await supabaseClient.rpc('get_next_order_number');
        const orderCode = `MMC-${orderNum}`;

        // 4. Create real order
        const orderType = pending.type_of_order || 'BLANK';
        const newOrder = await this.createOrder({
            organization_id: pending.organization_id,
            order_code: orderCode,
            order_number: orderNum,
            customer_id: customerId,
            customer_name: pending.customer_name,
            customer_phone: pending.customer_phone,
            sales_person_name: pending.sales_person,
            type_of_order: orderType,
            dispatch_mode: pending.dispatch_mode || 'PORTER',
            order_value: pending.order_value || 0,
            delivery_challan_file: pending.pdf_url,
            current_step: orderType === 'BLANK' ? 'STEP3_STOCK_UPDATE' : 'STEP2_EMAIL_PRODUCTION'
        });

        // 5. Mark pending as approved
        const session = await this.getSession();
        await supabaseClient.from('pending_orders').update({
            status: 'APPROVED',
            approved_by: session?.user?.id,
            approved_at: new Date().toISOString(),
            created_order_id: newOrder.id,
            created_order_code: orderCode
        }).eq('id', pendingId);

        return { orderId: newOrder.id, orderCode };
    },

    async rejectPendingOrder(pendingId, reason) {
        const { error } = await supabaseClient
            .from('pending_orders')
            .update({
                status: 'REJECTED',
                rejected_reason: reason || 'Manual rejection',
                approved_at: new Date().toISOString()
            })
            .eq('id', pendingId);
        if (error) throw error;
    },

    async updatePendingOrder(pendingId, updates) {
        const { error } = await supabaseClient
            .from('pending_orders')
            .update(updates)
            .eq('id', pendingId);
        if (error) throw error;
    },

    async cancelOrder(orderId, reason) {
        const session = await this.getSession();
        const { error } = await supabaseClient
            .from('orders')
            .update({
                is_cancelled: true,
                cancelled_at: new Date().toISOString(),
                cancelled_by: session?.user?.id,
                cancellation_reason: reason || null,
                current_step: null
            })
            .eq('id', orderId);
        if (error) throw error;
    },

    async restoreOrder(orderId) {
        const { error } = await supabaseClient
            .from('orders')
            .update({
                is_cancelled: false,
                cancelled_at: null,
                cancelled_by: null,
                cancellation_reason: null
            })
            .eq('id', orderId);
        if (error) throw error;
        await supabaseClient.rpc('refresh_order_status', { p_order_id: orderId });
    },
};