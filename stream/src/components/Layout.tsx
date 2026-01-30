import React from 'react';
import { Music, Disc, User as UserIcon } from 'lucide-react';
import { UserButton } from '@clerk/clerk-react';

const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    return (
        <div className="min-h-screen flex flex-col md:flex-row">
            {/* Sidebar */}
            <nav className="w-full md:w-64 border-b md:border-b-0 md:border-r border-zinc-800 p-6 flex flex-col gap-8 bg-black/50 backdrop-blur-xl">
                <div className="flex items-center gap-3 px-2">
                    <div className="w-10 h-10 bg-white rounded-lg flex items-center justify-center text-black font-bold text-xl">M</div>
                    <span className="font-bold tracking-tighter text-xl uppercase italic">Stream</span>
                </div>

                <div className="flex-1 space-y-2">
                    <NavItem icon={<Music size={18} />} label="My Library" active />
                    <NavItem icon={<Disc size={18} />} label="Discover" disabled />
                    <NavItem icon={<UserIcon size={18} />} label="Account" disabled />
                </div>

                <div className="px-4 py-3 flex items-center gap-3 border-t border-zinc-900 pt-6">
                    <UserButton afterSignOutUrl="/" appearance={{
                        elements: {
                            userButtonAvatarBox: 'w-10 h-10 rounded-xl',
                            userButtonTrigger: 'hover:scale-105 transition-transform'
                        }
                    }} />
                    <div className="hidden md:block">
                        <div className="text-xs text-white uppercase font-bold tracking-widest">Profile</div>
                        <div className="text-[10px] text-zinc-500 mono uppercase">Manage Session</div>
                    </div>
                </div>
            </nav>

            {/* Main Content */}
            <main className="flex-1 overflow-y-auto pb-32">
                {children}
            </main>
        </div>
    );
};

const NavItem = ({ icon, label, active = false, disabled = false }: { icon: any, label: string, active?: boolean, disabled?: boolean }) => (
    <div className={`flex items-center gap-3 px-4 py-3 rounded-xl transition-all ${active ? 'bg-zinc-800 text-white shadow-xl' : 'text-zinc-500 hover:text-zinc-200 cursor-pointer'
        } ${disabled ? 'opacity-30 cursor-not-allowed' : ''}`}>
        {icon}
        <span className="text-sm font-medium uppercase tracking-widest">{label}</span>
    </div>
);

export default Layout;
