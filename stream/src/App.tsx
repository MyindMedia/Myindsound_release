import React, { useState, useEffect } from 'react';
import { supabase } from './lib/supabase';
import { Session } from '@supabase/supabase-js';
import Auth from './components/Auth';
import Player from './components/Player';
import Library from './components/Library';
import Layout from './components/Layout';

interface Track {
  id: string;
  name: string;
  cover_url: string;
  audio_url: string;
  description: string;
}

const App: React.FC = () => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  const handlePlay = (track: Track) => {
    if (currentTrack?.id === track.id) {
      setIsPlaying(!isPlaying);
    } else {
      setCurrentTrack(track);
      setIsPlaying(true);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="animate-pulse text-white font-mono text-xs uppercase tracking-widest">Initialising Archive...</div>
      </div>
    );
  }

  if (!session) {
    return <Auth />;
  }

  return (
    <Layout>
      <div className="p-6 md:p-12 relative z-10">
        <header className="mb-16">
          <h1 className="text-5xl font-black text-white tracking-tighter uppercase mb-2">Collection</h1>
          <div className="h-1 w-20 bg-white" />
        </header>

        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-10">
          <Library
            userId={session.user.id}
            onPlay={handlePlay}
            activeTrackId={currentTrack?.id}
            isPlaying={isPlaying}
          />
        </section>
      </div>

      {currentTrack && (
        <Player
          track={currentTrack}
          isPlaying={isPlaying}
          setIsPlaying={setIsPlaying}
        />
      )}
    </Layout>
  );
};

export default App;
