import React, { useRef, useEffect, useState } from 'react';
import { Play, Pause, SkipBack, SkipForward, Volume2, Repeat, Shuffle } from 'lucide-react';

interface PlayerProps {
  track: {
    name: string;
    cover_url: string;
    audio_url: string;
  };
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
}

const Player: React.FC<PlayerProps> = ({ track, isPlaying, setIsPlaying }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.play().catch(console.error);
      } else {
        audioRef.current.pause();
      }
    }
  }, [isPlaying, track.audio_url]);

  const onTimeUpdate = () => {
    if (audioRef.current) {
      const current = audioRef.current.currentTime;
      const total = audioRef.current.duration;
      setProgress((current / total) * 100);
    }
  };

  const onLoadedMetadata = () => {
    if (audioRef.current) {
      setDuration(audioRef.current.duration);
    }
  };

  const formatTime = (time: number) => {
    if (isNaN(time)) return '0:00';
    const mins = Math.floor(time / 60);
    const secs = Math.floor(time % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (audioRef.current) {
      const width = e.currentTarget.clientWidth;
      const clickX = e.nativeEvent.offsetX;
      const newTime = (clickX / width) * duration;
      audioRef.current.currentTime = newTime;
    }
  };

  return (
    <div className="fixed bottom-0 left-0 right-0 h-28 bg-black/80 backdrop-blur-3xl border-t border-white/5 flex flex-col z-50 overflow-hidden shadow-[0_-20px_50px_rgba(0,0,0,0.5)]">
      {/* Invisible Audio Element */}
      <audio
        ref={audioRef}
        src={track.audio_url}
        onTimeUpdate={onTimeUpdate}
        onLoadedMetadata={onLoadedMetadata}
        onEnded={() => setIsPlaying(false)}
      />

      <div className="flex-1 flex items-center px-4 md:px-12">
        {/* Current Track Info */}
        <div className="flex items-center gap-6 w-1/4 min-w-[200px]">
          <div className="w-16 h-16 bg-zinc-900 rounded-xl overflow-hidden border border-white/10 shadow-2xl group flex-shrink-0">
            <img src={track.cover_url} alt={track.name} className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700" />
          </div>
          <div className="hidden sm:block">
            <div className="text-white text-base font-black uppercase tracking-tighter truncate w-40">{track.name}</div>
            <div className="text-zinc-500 text-[10px] mono uppercase tracking-[0.2em] mt-1">Playing From Archive</div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex-1 flex flex-col items-center gap-4">
          <div className="flex items-center gap-10 text-zinc-500">
            <Shuffle size={18} className="hover:text-white cursor-not-allowed transition-colors" />
            <SkipBack size={24} className="hover:text-white cursor-not-allowed transition-colors" />
            <button
              onClick={() => setIsPlaying(!isPlaying)}
              className="w-14 h-14 bg-white text-black rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shadow-[0_0_40px_rgba(255,255,255,0.15)]"
            >
              {isPlaying ? <Pause fill="black" size={24} /> : <Play fill="black" size={24} className="ml-1" />}
            </button>
            <SkipForward size={24} className="hover:text-white cursor-not-allowed transition-colors" />
            <Repeat size={18} className="hover:text-white cursor-not-allowed transition-colors" />
          </div>
        </div>

        {/* Volume / Extras (Hidden on mobile) */}
        <div className="w-1/4 hidden md:flex justify-end items-center gap-6 text-zinc-500">
          <Volume2 size={20} className="hover:text-white cursor-pointer transition-colors" />
          <div className="w-32 h-1 bg-zinc-800 rounded-full overflow-hidden cursor-pointer group">
            <div className="h-full w-3/4 bg-zinc-600 group-hover:bg-white transition-all shadow-[0_0_10px_rgba(255,255,255,0.3)]" />
          </div>
        </div>
      </div>

      {/* Progress Bar (Full Width at bottom of bar) */}
      <div
        className="w-full h-1 bg-zinc-900/50 cursor-pointer group relative"
        onClick={handleSeek}
      >
        <div
          className={`absolute top-0 left-0 h-full bg-white transition-all duration-100 ease-linear shadow-[0_0_20px_rgba(255,255,255,0.5)]`}
          style={{ width: `${progress}%` }}
        />
        <div className="absolute -top-10 left-1/2 -translate-x-1/2 flex gap-4 text-[10px] text-zinc-500 mono opacity-0 group-hover:opacity-100 transition-all translate-y-2 group-hover:translate-y-0">
          <span className="text-white">{formatTime(audioRef.current?.currentTime || 0)}</span>
          <span className="text-zinc-800">|</span>
          <span>{formatTime(duration)}</span>
        </div>
      </div>
    </div>
  );
};

export default Player;
