import React, { useState } from 'react';
import { supabase } from '../lib/supabase';

const Auth: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [email, setEmail] = useState('');
    const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setMessage(null);

        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: window.location.origin,
            },
        });

        if (error) {
            setMessage({ text: error.message, type: 'error' });
        } else {
            setMessage({ text: 'Check your email for the login link!', type: 'success' });
        }
        setLoading(false);
    };

    return (
        <div className="min-h-screen bg-black flex flex-col items-center justify-center p-4">
            <div className="w-full max-w-md bg-zinc-900/50 backdrop-blur-xl border border-zinc-800 p-8 rounded-2xl shadow-2xl">
                <div className="text-center mb-8">
                    <h2 className="text-3xl font-bold text-white uppercase tracking-tighter">Myind Stream</h2>
                    <p className="text-zinc-500 mt-2 font-mono text-sm">ACCESS YOUR PERSONAL COLLECTION</p>
                </div>

                <form onSubmit={handleLogin} className="space-y-6">
                    <div>
                        <label htmlFor="email" className="block text-xs font-medium text-zinc-400 uppercase tracking-widest mb-2">
                            Email Address
                        </label>
                        <input
                            id="email"
                            type="email"
                            placeholder="Enter your email"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="w-full bg-black/50 border border-zinc-700 text-white px-4 py-3 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-600 transition-all font-mono"
                            required
                        />
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full bg-white text-black font-bold py-4 rounded-xl hover:bg-zinc-200 transition-all active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-widest"
                    >
                        {loading ? 'SENDING...' : 'SEND MAGIC LINK'}
                    </button>
                </form>

                {message && (
                    <div className={`mt-6 p-4 rounded-xl text-center text-sm font-mono border ${message.type === 'success'
                            ? 'bg-emerald-500/10 border-emerald-500/50 text-emerald-400'
                            : 'bg-rose-500/10 border-rose-500/50 text-rose-400'
                        }`}>
                        {message.text}
                    </div>
                )}

                <div className="mt-8 pt-8 border-t border-zinc-800 text-center">
                    <p className="text-zinc-500 text-xs leading-relaxed uppercase tracking-widest">
                        Don't have an account? <br />
                        <span className="text-zinc-400">Accounts are created automatically upon purchase at myindsound.com</span>
                    </p>
                </div>
            </div>
        </div>
    );
};

export default Auth;
