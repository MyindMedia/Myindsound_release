import { supabase, getAdminStats } from './supabase';

class AdminDashboard {
    constructor() {
        this.init();
    }

    async init() {
        // Wait for Clerk
        const interval = setInterval(async () => {
            if ((window as any).Clerk) {
                clearInterval(interval);
                await (window as any).Clerk.load();
                this.checkAuth();
            }
        }, 100);

        document.getElementById('refresh-stats')?.addEventListener('click', () => this.loadStats());
    }

    async checkAuth() {
        const clerk = (window as any).Clerk;
        const user = clerk.user;

        if (!user) {
            window.location.href = '/login?redirect=/admin';
            return;
        }

        const email = user.primaryEmailAddress?.emailAddress;

        // Super Admin Check (info@myindsound.com or is_admin flag)
        const { data: profile } = await supabase
            .from('profiles')
            .select('is_admin')
            .eq('id', user.id)
            .single();

        if (email === 'info@myindsound.com' || profile?.is_admin) {
            document.getElementById('admin-content')!.style.display = 'block';
            document.getElementById('unauthorized')!.style.display = 'none';
            this.loadStats();
        } else {
            document.getElementById('admin-content')!.style.display = 'none';
            document.getElementById('unauthorized')!.style.display = 'flex';
        }
    }

    async loadStats() {
        const stats = await getAdminStats();

        // Update summary cards
        document.getElementById('total-plays')!.textContent = stats.plays.length.toString();
        document.getElementById('total-users')!.textContent = stats.users.length.toString();
        document.getElementById('total-purchases')!.textContent = stats.purchases.length.toString();

        // Populate Plays Table
        const playsTbody = document.querySelector('#recent-plays-table tbody')!;
        playsTbody.innerHTML = stats.plays.slice(0, 10).map((p: any) => `
            <tr>
                <td>${p.track_name}</td>
                <td>${p.user_id || 'Anonymous'}</td>
                <td>${new Date(p.played_at).toLocaleString()}</td>
            </tr>
        `).join('');

        // Populate Purchases Table
        const purchasesTbody = document.querySelector('#recent-purchases-table tbody')!;
        purchasesTbody.innerHTML = stats.purchases.slice(0, 10).map((p: any) => `
            <tr>
                <td>${p.products?.name || 'Unknown'}</td>
                <td>${p.user_id}</td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
            </tr>
        `).join('');
    }
}

new AdminDashboard();
