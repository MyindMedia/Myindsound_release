import React, { useState } from 'react';
import { SignedIn, SignedOut, RedirectToSignIn, useUser } from '@clerk/clerk-react';
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
  const { user } = useUser();
  const [currentTrack, setCurrentTrack] = useState<Track | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  const handlePlay = (track: Track) => {
    if (currentTrack?.id === track.id) {
      setIsPlaying(!isPlaying);
    } else {
      setCurrentTrack(track);
      setIsPlaying(true);
    }
  };

  return (
    <>
      <SignedIn>
        <Layout>
          <div className="p-6 md:p-12 relative z-10">
            <header className="mb-16">
              <h1 className="text-5xl font-black text-white tracking-tighter uppercase mb-2">Collection</h1>
              <div className="h-1 w-20 bg-white" />
            </header>

            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-10">
              {user && (
                <Library
                  userId={user.id}
                  onPlay={handlePlay}
                  activeTrackId={currentTrack?.id}
                  isPlaying={isPlaying}
                />
              )}
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
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
};

export default App;
