import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Play, Download, Lock } from 'lucide-react';

interface Product {
  id: string;
  name: string;
  description: string;
  cover_url: string;
  audio_url: string;
}

interface LibraryProps {
  userId: string;
  onPlay: (track: Product) => void;
  activeTrackId?: string;
  isPlaying: boolean;
}

const Library: React.FC<LibraryProps> = ({ userId, onPlay, activeTrackId, isPlaying }) => {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchLibrary = async () => {
      const { data, error } = await supabase
        .from('user_access')
        .select('products(*)')
        .eq('user_id', userId);

      if (!error && data) {
        setProducts(data.map((item: any) => item.products).filter(Boolean));
      }
      setLoading(false);
    };

    fetchLibrary();
  }, [userId]);

  const handleDownload = (e: React.MouseEvent, url: string, name: string) => {
    e.stopPropagation();
    if (!url) return;
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.zip`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  if (loading) {
    return (
      <div className="col-span-full py-20 text-center">
        <div className="text-zinc-600 mono animate-pulse uppercase tracking-[0.2em]">Scanning Archive...</div>
      </div>
    );
  }

  if (products.length === 0) {
    return (
      <div className="col-span-full py-20 text-center glass-panel border-dashed border-2 border-zinc-800 animate-slide-up">
        <Lock className="mx-auto text-zinc-700 mb-6" size={48} />
        <h3 className="text-xl font-bold text-zinc-400 uppercase tracking-widest">Library Empty</h3>
        <p className="text-zinc-600 mt-2 max-w-sm mx-auto leading-relaxed">Purchase releases at myindsound.com to unlock streaming and high-quality downloads.</p>
      </div>
    );
  }

  return (
    <>
      {products.map((track) => {
        const isActive = activeTrackId === track.id;
        return (
          <div key={track.id} className="group animate-slide-up cursor-pointer" onClick={() => onPlay(track)}>
            <div className={`relative aspect-square mb-6 overflow-hidden rounded-2xl border transition-all duration-700 shadow-2xl ${isActive ? 'border-white ring-8 ring-white/5' : 'border-zinc-800/50 group-hover:border-zinc-500'
              }`}>
              <img
                src={track.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&q=80&w=1000'}
                alt={track.name}
                className={`w-full h-full object-cover transition-transform duration-1000 ${isActive ? 'scale-105' : 'group-hover:scale-110'}`}
              />
              <div className={`absolute inset-0 bg-black/40 flex items-center justify-center backdrop-blur-[2px] transition-opacity duration-300 ${isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                }`}>
                <div className={`w-20 h-20 bg-white text-black rounded-full flex items-center justify-center shadow-2xl transition-all duration-500 ${isActive ? 'scale-100' : 'scale-75 group-hover:scale-100'
                  }`}>
                  {isActive && isPlaying ? (
                    <div className="flex gap-1.5 items-end h-6">
                      <div className="w-1.5 bg-black animate-[bounce_0.6s_infinite]" />
                      <div className="w-1.5 bg-black animate-[bounce_0.9s_infinite]" />
                      <div className="w-1.5 bg-black animate-[bounce_0.75s_infinite]" />
                    </div>
                  ) : (
                    <Play fill="black" size={32} className="ml-1" />
                  )}
                </div>
              </div>

              <div className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 transition-all translate-y-2 group-hover:translate-y-0">
                <button
                  onClick={(e) => handleDownload(e, track.audio_url, track.name)}
                  className="p-3 bg-zinc-900/90 backdrop-blur-xl rounded-xl text-white hover:bg-white hover:text-black transition-all shadow-2xl border border-white/10"
                >
                  <Download size={20} />
                </button>
              </div>
            </div>

            <h3 className="font-bold text-xl uppercase tracking-tighter text-zinc-100 mb-1 group-hover:text-white transition-colors">{track.name}</h3>
            <p className="text-zinc-500 text-sm mono leading-relaxed h-10 overflow-hidden group-hover:text-zinc-400 transition-colors uppercase tracking-widest">{track.description}</p>
          </div>
        );
      })}
    </>
  );
};

export default Library;
