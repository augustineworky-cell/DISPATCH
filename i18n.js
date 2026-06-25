/**
 * MMC Dispatch OS - Internationalization (i18n) Configuration
 * Supports: English (en), Hindi (hi)
 */
window.i18n = {
    en: {
        app_name: "MMC Dispatch OS",
        dashboard: "Dashboard",
        kanban: "Kanban Board",
        orders: "Orders",
        new_order: "New Order",
        settings: "Settings",
        logout: "Logout",
        search_placeholder: "Search orders, customers...",
        total_orders: "Total Orders",
        dispatched_today: "Dispatched Today",
        in_progress: "In Progress",
        delayed: "Delayed",
        pipeline_health: "Pipeline Health",
        critical_delays: "Critical Delays",
        top_performers: "Top Performers",
        order_code: "Order ID",
        customer: "Customer",
        due_date: "Due Date",
        status: "Status",
        ask_jarvis: "Ask Jarvis AI...",
        submit: "Submit",
        cancel: "Cancel",
        step_completed: "Step marked as done successfully.",
        error_occurred: "An error occurred. Please try again.",
        create_order: "Create Order",
        order_details: "Order Details"
    },
    hi: {
        app_name: "MMC डिस्पैच OS",
        dashboard: "डैशबोर्ड",
        kanban: "कानबन बोर्ड",
        orders: "ऑर्डर्स",
        new_order: "नया ऑर्डर",
        settings: "सेटिंग्स",
        logout: "लॉग आउट",
        search_placeholder: "ऑर्डर या कस्टमर खोजें...",
        total_orders: "कुल ऑर्डर्स",
        dispatched_today: "आज डिस्पैच हुए",
        in_progress: "प्रगति पर (In Progress)",
        delayed: "देरी से (Delayed)",
        pipeline_health: "पाइपलाइन स्थिति",
        critical_delays: "महत्वपूर्ण देरी",
        top_performers: "टॉप परफ़ॉर्मर",
        order_code: "ऑर्डर ID",
        customer: "कस्टमर",
        due_date: "देय तिथि",
        status: "स्थिति",
        ask_jarvis: "Jarvis AI से पूछें...",
        submit: "सबमिट करें",
        cancel: "रद्द करें",
        step_completed: "स्टेप सफलतापूर्वक पूरा हो गया।",
        error_occurred: "एक त्रुटि हुई। कृपया पुनः प्रयास करें।",
        create_order: "ऑर्डर बनाएं",
        order_details: "ऑर्डर विवरण"
    }
};

/**
 * Robust Translation Helper
 * Fetches the requested key based on the currently selected language in localStorage.
 * Falls back to English ('en') if no language is set, or returns the key itself if missing.
 * * @param {string} key - The dictionary key to look up.
 * @returns {string} - The translated string, or the original key if not found/error occurs.
 */
window.t = (key) => {
    try {
        // Retrieve language preference from localStorage, defaulting to 'en'
        const lang = localStorage.getItem('mmc_lang') || 'en';
        
        // If the language object doesn't exist in i18n, return the key as a fallback
        if (!window.i18n[lang]) {
            return key;
        }
        
        // Return the translated string if it exists, otherwise fallback to the key
        return window.i18n[lang][key] || key;
    } catch (e) {
        // Fallback if localStorage is inaccessible (e.g., restricted iframe, strict privacy settings)
        console.warn("Translation helper encountered an error:", e);
        return key; 
    }
};