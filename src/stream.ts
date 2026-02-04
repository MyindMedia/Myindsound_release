/**
 * Stream Player Controller
 * Y2K-inspired mini disc music player with visualizer
 */

import './style.css';
import { logTrackPlay } from './supabase';
import { getUserId } from './clerk';
import { DiskPlayerAnimator, EnhancedDiskPlayerAnimator } from './disk-player';

interface Track {
  id: number;
  title: string;
  artist: string;
  duration: string;
  durationSeconds: number;
  src: string;
  cover: string;
}

// LIT Album Tracks - Update these URLs with actual audio files from Supabase
const TRACKS: Track[] = [
  {
    id: 1,
    title: 'L.I.T. (Living In Truth)',
    artist: 'Myind Sound',
    duration: '4:12',
    durationSeconds: 252,
    src: '', // Add Supabase audio URL
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 2,
    title: 'G. O. D.',
    artist: 'Myind Sound',
    duration: '3:45',
    durationSeconds: 225,
    src: '',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 3,
    title: 'Victory In the Valley',
    artist: 'Myind Sound',
    duration: '4:28',
    durationSeconds: 268,
    src: '',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 4,
    title: 'Tired',
    artist: 'Myind Sound',
    duration: '3:52',
    durationSeconds: 232,
    src: '',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 5,
    title: 'Let Him Cook',
    artist: 'Myind Sound',
    duration: '4:05',
    durationSeconds: 245,
    src: '',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 6,
    title: 'Faith',
    artist: 'Myind Sound',
    duration: '4:10',
    durationSeconds: 250,
    src: '',
    cover: '/assets/images/lit-poster.png'
  }
];

class StreamPlayer {
  private audio: HTMLAudioElement;
  private tracks: Track[] = TRACKS;
  private currentTrackIndex: number = 0;
  private isPlaying: boolean = false;
  private isShuffle: boolean = false;
  private repeatMode: 'none' | 'all' | 'one' = 'none';
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;
  private animationId: number | null = null;
  private diskAnimator: DiskPlayerAnimator | null = null;
  private introOverlay: HTMLElement | null = null;
  // private isIntroMode: boolean = false;
  private hasStartedPlaying: boolean = false;

  // DOM Elements
  private playBtn: HTMLElement | null;
  private playIcon: HTMLElement | null;
  private pauseIcon: HTMLElement | null;
  private progressFill: HTMLElement | null;
  private progressBar: HTMLElement | null;
  private timeCurrent: HTMLElement | null;
  private timeTotal: HTMLElement | null;
  private nowPlayingTitle: HTMLElement | null;
  private nowPlayingArtist: HTMLElement | null;
  private tracklistEl: HTMLElement | null;
  private visualizerCanvas: HTMLCanvasElement | null;
  private canvasCtx: CanvasRenderingContext2D | null = null;

  constructor() {
    this.audio = document.getElementById('audio-player') as HTMLAudioElement;
    this.playBtn = document.getElementById('play-btn');
    this.playIcon = this.playBtn?.querySelector('.play-icon') as HTMLElement;
    this.pauseIcon = this.playBtn?.querySelector('.pause-icon') as HTMLElement;
    this.progressFill = document.getElementById('progress-fill');
    this.progressBar = document.getElementById('progress-bar');
    this.timeCurrent = document.getElementById('time-current');
    this.timeTotal = document.getElementById('time-total');
    this.nowPlayingTitle = document.getElementById('now-playing-title');
    this.nowPlayingArtist = document.getElementById('now-playing-artist');
    this.tracklistEl = document.getElementById('tracklist');
    this.visualizerCanvas = document.getElementById('visualizer') as HTMLCanvasElement;
    this.introOverlay = document.getElementById('intro-overlay');

    if (this.visualizerCanvas) {
      this.canvasCtx = this.visualizerCanvas.getContext('2d');
    }

    this.init();
  }

  private async init() {
    // Initialize Disk Animator
    if (typeof (window as any).gsap !== 'undefined') {
      this.diskAnimator = new EnhancedDiskPlayerAnimator((window as any).gsap);
    } else {
      this.diskAnimator = new DiskPlayerAnimator();
    }

    await this.fetchSignedUrls();
    this.renderTracklist();
    this.setupEventListeners();
    this.loadTrack(0);
    this.updateAlbumDuration();

    // Check for intro mode
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('new_purchase') === 'true') {
      this.startIntroSequence();
    } else {
      this.setupInitialState();
    }

    // Start idle visualizer animation
    this.drawIdleVisualizer();
  }

  private setupInitialState() {
    // Hide tracklist and visualizer initially
    const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;
    const visualizerContainer = document.querySelector('.visualizer-container') as HTMLElement;
    const streamContainer = document.querySelector('.stream-container') as HTMLElement;
    
    if (tracklistSection) {
      tracklistSection.style.opacity = '0';
      tracklistSection.style.pointerEvents = 'none';
      tracklistSection.style.transform = 'translateX(20px)';
      tracklistSection.style.transition = 'all 0.5s ease';
    }
    
    if (visualizerContainer) {
      visualizerContainer.style.opacity = '0';
      visualizerContainer.style.height = '0';
      visualizerContainer.style.overflow = 'hidden';
      visualizerContainer.style.margin = '0';
      visualizerContainer.style.transition = 'all 0.5s ease';
    }
    
    // Center the player
    if (streamContainer) {
      streamContainer.style.gridTemplateColumns = '1fr';
      streamContainer.style.justifyItems = 'center';
    }
    
    // Add pulsating effect to play button
    this.playBtn?.classList.add('pulsating-play');
  }

  private startIntroSequence() {
    if (!this.introOverlay) return;
    
    // Setup initial state behind overlay
    this.setupInitialState();
    
    this.introOverlay.classList.add('active');
    
    const gsap = (window as any).gsap;
    if (!gsap) {
      // Fallback if GSAP not loaded
      setTimeout(() => {
        this.introOverlay?.classList.remove('active');
      }, 2000);
      return;
    }
    
    const albumArt = document.getElementById('intro-album-art');
    const peelLayer = document.getElementById('intro-peel-layer');
    
    const tl = gsap.timeline();
    
    // Shake effect
    tl.to(albumArt, {
      x: -5,
      duration: 0.1,
      repeat: 5,
      yoyo: true,
      ease: "power1.inOut"
    })
    .to(albumArt, {
      x: 5,
      duration: 0.1,
      repeat: 5,
      yoyo: true,
      ease: "power1.inOut"
    }, "<")
    
    // Peel effect
    .to(peelLayer, {
      xPercent: -100,
      yPercent: -100,
      rotation: -45,
      opacity: 0,
      duration: 1.5,
      ease: "power2.inOut"
    })
    
    // Fade out overlay
    .to(this.introOverlay, {
      opacity: 0,
      duration: 1,
      onComplete: () => {
        this.introOverlay?.classList.remove('active');
        this.introOverlay!.style.display = 'none';
      }
    });
  }

  private async fetchSignedUrls() {
    try {
      const userId = await getUserId();
      if (!userId) return;

      const response = await fetch('/.netlify/functions/get-stream-urls', {
        headers: {
          'x-user-id': userId
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch stream URLs:', await response.text());
        return;
      }

      const data = await response.json();
      const signedTracks = data.tracks;

      // Map signed URLs to our tracks array based on order (1-6)
      this.tracks = this.tracks.map((track, index) => {
        const signedTrack = signedTracks[index];
        if (signedTrack && signedTrack.url) {
          return { ...track, src: signedTrack.url };
        }
        return track;
      });
    } catch (e) {
      console.error('Error fetching signed URLs:', e);
    }
  }

  private setupEventListeners() {
    // Play/Pause
    this.playBtn?.addEventListener('click', () => this.togglePlay());

    // Previous/Next
    document.getElementById('prev-btn')?.addEventListener('click', () => this.prevTrack());
    document.getElementById('next-btn')?.addEventListener('click', () => this.nextTrack());

    // Shuffle/Repeat
    document.getElementById('shuffle-btn')?.addEventListener('click', () => this.toggleShuffle());
    document.getElementById('repeat-btn')?.addEventListener('click', () => this.toggleRepeat());

    // Volume
    const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
    volumeSlider?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value);
      this.setVolume(value / 100);
    });

    document.getElementById('volume-btn')?.addEventListener('click', () => this.toggleMute());

    // Progress bar click
    this.progressBar?.addEventListener('click', (e) => this.seekTo(e));

    // Audio events
    this.audio.addEventListener('timeupdate', () => this.updateProgress());
    this.audio.addEventListener('ended', () => this.onTrackEnd());
    this.audio.addEventListener('loadedmetadata', () => this.updateTimeDisplay());
    this.audio.addEventListener('play', () => this.onPlay());
    this.audio.addEventListener('pause', () => this.onPause());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleKeyboard(e));
  }

  private renderTracklist() {
    if (!this.tracklistEl) return;

    this.tracklistEl.innerHTML = this.tracks.map((track, index) => `
      <div class="track-item ${index === this.currentTrackIndex ? 'active' : ''}" data-index="${index}">
        <div class="track-number">${(index + 1).toString().padStart(2, '0')}</div>
        <div class="track-info">
          <span class="track-title">${track.title}</span>
          <span class="track-artist">${track.artist}</span>
        </div>
        <div class="track-duration">${track.duration}</div>
        <div class="track-playing-indicator">
          <span></span><span></span><span></span>
        </div>
      </div>
    `).join('');

    // Add click handlers
    this.tracklistEl.querySelectorAll('.track-item').forEach(item => {
      item.addEventListener('click', () => {
        const index = parseInt(item.getAttribute('data-index') || '0');
        this.loadTrack(index);
        this.play();
      });
    });
  }

  private loadTrack(index: number) {
    this.currentTrackIndex = index;
    const track = this.tracks[index];

    // Update audio source
    if (track.src) {
      this.audio.src = track.src;
    }

    // Update now playing info
    if (this.nowPlayingTitle) this.nowPlayingTitle.textContent = track.title;
    if (this.nowPlayingArtist) this.nowPlayingArtist.textContent = track.artist;

    // Update disc artwork
    const discArtwork = document.querySelector('.disc-artwork') as HTMLImageElement;
    if (discArtwork) discArtwork.src = track.cover;

    // Update tracklist active state
    this.tracklistEl?.querySelectorAll('.track-item').forEach((item, i) => {
      item.classList.toggle('active', i === index);
    });

    // Update time display
    if (this.timeTotal) this.timeTotal.textContent = track.duration;
    if (this.timeCurrent) this.timeCurrent.textContent = '0:00';
    if (this.progressFill) this.progressFill.style.width = '0%';
  }

  private togglePlay() {
    if (this.isPlaying) {
      this.pause();
    } else {
      this.play();
    }
  }

  private play() {
    // For demo purposes, simulate playing even without audio source
    if (this.tracks[this.currentTrackIndex].src) {
      this.audio.play().catch(console.error);
    } else {
      // Simulate play for demo
      this.onPlay();
      this.simulateProgress();
    }
  }

  private pause() {
    this.audio.pause();
    this.onPause();
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
  }

  private simulationInterval: ReturnType<typeof setInterval> | null = null;
  private simulatedTime: number = 0;

  private simulateProgress() {
    const track = this.tracks[this.currentTrackIndex];
    this.simulationInterval = setInterval(() => {
      this.simulatedTime += 1;
      const progress = (this.simulatedTime / track.durationSeconds) * 100;

      if (this.progressFill) this.progressFill.style.width = `${progress}%`;
      if (this.timeCurrent) this.timeCurrent.textContent = this.formatTime(this.simulatedTime);

      if (this.simulatedTime >= track.durationSeconds) {
        this.simulatedTime = 0;
        this.onTrackEnd();
      }
    }, 1000);
  }

  private async onPlay() {
    this.isPlaying = true;
    if (this.playIcon) this.playIcon.style.display = 'none';
    if (this.pauseIcon) this.pauseIcon.style.display = 'block';
    
    // Reveal UI if first play
    if (!this.hasStartedPlaying) {
      this.hasStartedPlaying = true;
      this.playBtn?.classList.remove('pulsating-play');
      
      const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;
      const visualizerContainer = document.querySelector('.visualizer-container') as HTMLElement;
      const streamContainer = document.querySelector('.stream-container') as HTMLElement;
      
      if (streamContainer) {
        // Reset grid
        streamContainer.style.gridTemplateColumns = '1fr 400px';
        streamContainer.style.justifyItems = 'start'; // or default
      }
      
      if (visualizerContainer) {
        visualizerContainer.style.height = 'auto'; // Let it grow
        visualizerContainer.style.overflow = 'visible';
        visualizerContainer.style.margin = ''; // Reset
        visualizerContainer.style.opacity = '1';
      }
      
      if (tracklistSection) {
        tracklistSection.style.opacity = '1';
        tracklistSection.style.pointerEvents = 'auto';
        tracklistSection.style.transform = 'translateX(0)';
      }
    }

    // Log the play event
    const currentTrack = this.tracks[this.currentTrackIndex];
    if (currentTrack) {
      // Find user ID if signed in
      let userId = undefined;
      try {
        if (window.Clerk?.user) {
          userId = window.Clerk.user.id;
        }
      } catch (e) { }

      // LIT Product ID: f67a66b8-59a0-413f-b943-8fbb9cdee876
      await logTrackPlay(currentTrack.title, 'f67a66b8-59a0-413f-b943-8fbb9cdee876', userId);
    }

    if (this.audioContext && this.audioContext.state === 'suspended') {
      this.audioContext.resume();
    }

    // Start disk animation
    this.diskAnimator?.setPlaying(true);

    // Start visualizer
    this.initAudioContext();
    this.startVisualizer();
  }

  private onPause() {
    this.isPlaying = false;
    // Stop disk animation
    this.diskAnimator?.setPlaying(false);
    
    if (this.playIcon) this.playIcon.style.display = 'block';
    if (this.pauseIcon) this.pauseIcon.style.display = 'none';

    // Keep visualizer in idle state
    this.drawIdleVisualizer();
  }

  private prevTrack() {
    let newIndex = this.currentTrackIndex - 1;
    if (newIndex < 0) newIndex = this.tracks.length - 1;

    this.simulatedTime = 0;
    this.loadTrack(newIndex);
    if (this.isPlaying) this.play();
  }

  private nextTrack() {
    let newIndex: number;

    if (this.isShuffle) {
      newIndex = Math.floor(Math.random() * this.tracks.length);
    } else {
      newIndex = this.currentTrackIndex + 1;
      if (newIndex >= this.tracks.length) newIndex = 0;
    }

    this.simulatedTime = 0;
    this.loadTrack(newIndex);
    if (this.isPlaying) this.play();
  }

  private onTrackEnd() {
    if (this.repeatMode === 'one') {
      this.simulatedTime = 0;
      this.loadTrack(this.currentTrackIndex);
      this.play();
    } else if (this.repeatMode === 'all' || this.currentTrackIndex < this.tracks.length - 1) {
      this.nextTrack();
    } else {
      this.pause();
      this.loadTrack(0);
    }
  }

  private toggleShuffle() {
    this.isShuffle = !this.isShuffle;
    document.getElementById('shuffle-btn')?.classList.toggle('active', this.isShuffle);
  }

  private toggleRepeat() {
    const modes: Array<'none' | 'all' | 'one'> = ['none', 'all', 'one'];
    const currentIndex = modes.indexOf(this.repeatMode);
    this.repeatMode = modes[(currentIndex + 1) % modes.length];

    const btn = document.getElementById('repeat-btn');
    btn?.classList.remove('active', 'repeat-one');

    if (this.repeatMode === 'all') {
      btn?.classList.add('active');
    } else if (this.repeatMode === 'one') {
      btn?.classList.add('active', 'repeat-one');
    }
  }

  private setVolume(value: number) {
    this.audio.volume = value;
    this.updateVolumeIcon(value);
  }

  private toggleMute() {
    this.audio.muted = !this.audio.muted;
    const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
    this.updateVolumeIcon(this.audio.muted ? 0 : parseFloat(volumeSlider?.value || '80') / 100);
  }

  private updateVolumeIcon(value: number) {
    const volumeIcon = document.querySelector('.volume-icon') as HTMLElement;
    const muteIcon = document.querySelector('.mute-icon') as HTMLElement;

    if (value === 0 || this.audio.muted) {
      if (volumeIcon) volumeIcon.style.display = 'none';
      if (muteIcon) muteIcon.style.display = 'block';
    } else {
      if (volumeIcon) volumeIcon.style.display = 'block';
      if (muteIcon) muteIcon.style.display = 'none';
    }
  }

  private seekTo(e: MouseEvent) {
    if (!this.progressBar) return;

    const rect = this.progressBar.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    const track = this.tracks[this.currentTrackIndex];

    if (track.src) {
      this.audio.currentTime = percent * this.audio.duration;
    } else {
      this.simulatedTime = Math.floor(percent * track.durationSeconds);
      if (this.progressFill) this.progressFill.style.width = `${percent * 100}%`;
      if (this.timeCurrent) this.timeCurrent.textContent = this.formatTime(this.simulatedTime);
    }
  }

  private updateProgress() {
    if (!this.audio.duration) return;

    const percent = (this.audio.currentTime / this.audio.duration) * 100;
    if (this.progressFill) this.progressFill.style.width = `${percent}%`;
    if (this.timeCurrent) this.timeCurrent.textContent = this.formatTime(this.audio.currentTime);
  }

  private updateTimeDisplay() {
    if (this.timeTotal && this.audio.duration) {
      this.timeTotal.textContent = this.formatTime(this.audio.duration);
    }
  }

  private formatTime(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private updateAlbumDuration() {
    const totalSeconds = this.tracks.reduce((sum, track) => sum + track.durationSeconds, 0);
    const mins = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    const durationEl = document.getElementById('album-duration');
    if (durationEl) durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private handleKeyboard(e: KeyboardEvent) {
    switch (e.code) {
      case 'Space':
        e.preventDefault();
        this.togglePlay();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        this.prevTrack();
        break;
      case 'ArrowRight':
        e.preventDefault();
        this.nextTrack();
        break;
      case 'ArrowUp':
        e.preventDefault();
        this.setVolume(Math.min(1, this.audio.volume + 0.1));
        break;
      case 'ArrowDown':
        e.preventDefault();
        this.setVolume(Math.max(0, this.audio.volume - 0.1));
        break;
    }
  }

  // Audio Visualizer
  private initAudioContext() {
    if (this.audioContext) return;

    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048; // Increased for better waveform resolution

      const source = this.audioContext.createMediaElementSource(this.audio);
      source.connect(this.analyser);
      this.analyser.connect(this.audioContext.destination);

      const bufferLength = this.analyser.frequencyBinCount;
      this.dataArray = new Uint8Array(bufferLength);
    } catch (e) {
      console.log('Web Audio API not supported or already initialized');
    }
  }

  private startVisualizer() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.drawVisualizer();
  }

  private drawVisualizer() {
    if (!this.canvasCtx || !this.visualizerCanvas) return;

    this.animationId = requestAnimationFrame(() => this.drawVisualizer());

    const width = this.visualizerCanvas.width;
    const height = this.visualizerCanvas.height;

    // Clear canvas
    // Clear canvas with subtle transparency for trail effect
    this.canvasCtx.fillStyle = '#0a0a0a';
    this.canvasCtx.fillRect(0, 0, width, height);

    if (this.isPlaying) {
      if (this.analyser && this.dataArray && this.tracks[this.currentTrackIndex].src) {
        // Real Audio Waveform
        this.analyser.getByteTimeDomainData(this.dataArray as any);
      } else {
        // Simulated Waveform for tracks without files
        this.generateSimulatedWaveform();
      }

      // Draw Premium Waveform (Symmetrical Bars)
      const bufferLength = this.dataArray?.length || 0;
      const barWidth = (width / bufferLength) * 2;
      let x = 0;

      this.canvasCtx.shadowBlur = 15;
      this.canvasCtx.shadowColor = 'rgba(255, 215, 0, 0.5)';

      for (let i = 0; i < bufferLength; i++) {
        const v = (this.dataArray![i] / 128.0) - 1.0; // -1 to 1
        const amplitude = Math.abs(v) * (height / 2) * 0.8;

        // Create gold gradient for each bar
        const gradient = this.canvasCtx.createLinearGradient(0, (height / 2) - amplitude, 0, (height / 2) + amplitude);
        gradient.addColorStop(0, 'rgba(184, 134, 11, 0.2)'); // Darker Gold (Top)
        gradient.addColorStop(0.5, '#FFD700');                // Bright Gold (Middle)
        gradient.addColorStop(1, 'rgba(184, 134, 11, 0.2)');  // Darker Gold (Bottom)

        this.canvasCtx.fillStyle = gradient;

        // Draw the bar symmetrically from the middle
        this.canvasCtx.fillRect(x, (height / 2) - amplitude, barWidth - 1, amplitude * 2);

        x += barWidth;
      }

      // Add a persistent center line
      this.canvasCtx.fillStyle = 'rgba(255, 215, 0, 0.3)';
      this.canvasCtx.fillRect(0, (height / 2) - 1, width, 2);
    } else {
      // Draw idle animation
      this.drawIdleBars();
    }
  }

  private generateSimulatedWaveform() {
    if (!this.dataArray) return;
    const time = performance.now() * 0.005;
    for (let i = 0; i < this.dataArray.length; i++) {
      // Create a complex wave using multiple sine waves for "active" look
      const wave1 = Math.sin(i * 0.05 + time);
      const wave2 = Math.sin(i * 0.1 + time * 1.5) * 0.5;
      const wave3 = Math.sin(i * 0.02 + time * 0.5) * 0.3;
      const combined = (wave1 + wave2 + wave3) / 1.8;

      // Map to 0-255 range (middle is 128)
      this.dataArray[i] = 128 + (combined * 64);
    }
  }

  private drawIdleVisualizer() {
    if (this.animationId) cancelAnimationFrame(this.animationId);
    this.animationId = requestAnimationFrame(() => this.animateIdleVisualizer());
  }

  private idlePhase = 0;

  private animateIdleVisualizer() {
    if (this.isPlaying) return;

    this.animationId = requestAnimationFrame(() => this.animateIdleVisualizer());

    if (!this.canvasCtx || !this.visualizerCanvas) return;

    const width = this.visualizerCanvas.width;
    const height = this.visualizerCanvas.height;

    this.canvasCtx.fillStyle = 'rgba(10, 10, 10, 0.2)';
    this.canvasCtx.fillRect(0, 0, width, height);

    this.idlePhase += 0.02;
    this.drawIdleBars();
  }

  private drawIdleBars() {
    if (!this.canvasCtx || !this.visualizerCanvas) return;

    const width = this.visualizerCanvas.width;
    const height = this.visualizerCanvas.height;
    const barCount = 64;
    const barWidth = (width / barCount) * 0.8;

    for (let i = 0; i < barCount; i++) {
      const x = (i / barCount) * width;
      const barHeight = (Math.sin(this.idlePhase + i * 0.1) * 0.3 + 0.4) * (height * 0.3);

      const gradient = this.canvasCtx.createLinearGradient(0, height - barHeight, 0, height);
      gradient.addColorStop(0, 'rgba(255, 215, 0, 0.6)');
      gradient.addColorStop(1, 'rgba(184, 134, 11, 0.3)');

      this.canvasCtx.fillStyle = gradient;
      this.canvasCtx.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new StreamPlayer();
  });
} else {
  new StreamPlayer();
}
