/**
 * Stream Player Controller
 * Y2K-inspired mini disc music player with visualizer
 */

import './style.css';
import { logTrackPlay } from './supabase';
import { getUserId } from './clerk';
import { DiskPlayerAnimator, EnhancedDiskPlayerAnimator } from './disk-player';
// import { UnicornSceneManager } from './unicorn-scene';

// Ensure scroll is never locked on page load
document.body.style.overflow = '';
document.documentElement.style.overflow = '';

interface Track {
  id: number;
  title: string;
  artist: 'Myind Sound';
  duration: string;
  durationSeconds: number;
  src: string;
  cover: string;
  isUpcoming?: boolean;
  offset?: number;
}

// LIT Album Tracks - Supabase signed URLs
const TRACKS: Track[] = [
  {
    id: 1,
    title: 'L.I.T. (Living In Truth)',
    artist: 'Myind Sound',
    duration: '4:12',
    durationSeconds: 252,
    src: 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/sign/LIT/1.%20L.I.T.%20(%20Living%20In%20Truth).mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yNzkyMzE4YS00YWI2LTQwMTgtYjFkOS1iZWFiODAxZThhOGIiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJMSVQvMS4gTC5JLlQuICggTGl2aW5nIEluIFRydXRoKS5tcDMiLCJpYXQiOjE3NzAzMjc2NjEsImV4cCI6NDg5MjM5MTY2MX0.6q79m3rAVEwzb9xkrm_H_ubZ9n82octjru2WHDOkcto',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 2,
    title: 'G. O. D.',
    artist: 'Myind Sound',
    duration: '3:45',
    durationSeconds: 225,
    src: 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/sign/LIT/2.%20G.%20O.%20D.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yNzkyMzE4YS00YWI2LTQwMTgtYjFkOS1iZWFiODAxZThhOGIiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJMSVQvMi4gRy4gTy4gRC5tcDMiLCJpYXQiOjE3NzAzMjc2OTEsImV4cCI6NDg5MjM5MTY5MX0.GPhO_OWCjXzGofAHdhbLzasBIKFGMjnVRVa3Q_7z4gk',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 3,
    title: 'Victory In the Valley',
    artist: 'Myind Sound',
    duration: '4:28',
    durationSeconds: 268,
    src: 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/sign/LIT/3.%20Victory%20In%20the%20Valley.wav?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yNzkyMzE4YS00YWI2LTQwMTgtYjFkOS1iZWFiODAxZThhOGIiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJMSVQvMy4gVmljdG9yeSBJbiB0aGUgVmFsbGV5LndhdiIsImlhdCI6MTc3MDMyNzcwNywiZXhwIjo0ODkyMzkxNzA3fQ.hXI7OkXMYOZYHovd2ZIKxZBZXjqkHNmR7HlJcrNxJIY',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 4,
    title: 'Tired',
    artist: 'Myind Sound',
    duration: '3:52',
    durationSeconds: 232,
    src: 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/sign/LIT/4.%20Tired.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yNzkyMzE4YS00YWI2LTQwMTgtYjFkOS1iZWFiODAxZThhOGIiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJMSVQvNC4gVGlyZWQubXAzIiwiaWF0IjoxNzcwMzI3NzU3LCJleHAiOjQ4OTIzOTE3NTd9.EzYIppm6cRw2FQECDhOZBJ1j6OSlaaJWMqT5ljLqIqk',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 5,
    title: 'Let Him Cook',
    artist: 'Myind Sound',
    duration: '4:05',
    durationSeconds: 245,
    src: 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/sign/LIT/5.%20Let%20Him%20Cook.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yNzkyMzE4YS00YWI2LTQwMTgtYjFkOS1iZWFiODAxZThhOGIiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJMSVQvNS4gTGV0IEhpbSBDb29rLm1wMyIsImlhdCI6MTc3MDMyNzc3OCwiZXhwIjo0ODkyMzkxNzc4fQ.xFO2txas0PVIrouPi7VOWg7x-Pw1lCZoLuKu6soJNOA',
    cover: '/assets/images/lit-poster.png'
  },
  {
    id: 6,
    title: 'Faith',
    artist: 'Myind Sound',
    duration: '4:10',
    durationSeconds: 250,
    src: 'https://luowwakouydxyzfnsyki.supabase.co/storage/v1/object/sign/LIT/6.%20Faith.mp3?token=eyJraWQiOiJzdG9yYWdlLXVybC1zaWduaW5nLWtleV8yNzkyMzE4YS00YWI2LTQwMTgtYjFkOS1iZWFiODAxZThhOGIiLCJhbGciOiJIUzI1NiJ9.eyJ1cmwiOiJMSVQvNi4gRmFpdGgubXAzIiwiaWF0IjoxNzcwMzI3ODAzLCJleHAiOjQ4OTIzOTE4MDN9.J5My_NPQ7dNGjegxRe5r_liqbA09RHsjxmv__p_55tI',
    cover: '/assets/images/lit-poster.png'
  }
];

class StreamPlayer {
  private audio: HTMLAudioElement;
  private tracks: Track[] = TRACKS;
  private currentTrackIndex: number = 0;
  private isPlaying: boolean = false;
  private diskAnimator: DiskPlayerAnimator | null = null;
  private introOverlay: HTMLElement | null = null;
  private hasStartedPlaying: boolean = false;
  private loadingAudio: HTMLAudioElement | null = null;
  private repeatMode: 'none' | 'all' | 'one' = 'none';

  // DOM Elements
  private progressFill: HTMLElement | null;
  private progressBar: HTMLElement | null;
  private timeCurrent: HTMLElement | null;
  private timeTotal: HTMLElement | null;
  private nowPlayingTitle: HTMLElement | null;
  private nowPlayingArtist: HTMLElement | null;
  private tracklistEl: HTMLElement | null;
  private upcomingScrollEl: HTMLElement | null;
  private tracklistSection: HTMLElement | null;

  constructor() {
    this.audio = document.getElementById('audio-player') as HTMLAudioElement;
    this.progressFill = document.getElementById('progress-fill');
    this.progressBar = document.getElementById('progress-bar');
    this.timeCurrent = document.getElementById('time-current');
    this.timeTotal = document.getElementById('time-total');
    this.nowPlayingTitle = document.getElementById('now-playing-title');
    this.nowPlayingArtist = document.getElementById('now-playing-artist');
    this.tracklistEl = document.getElementById('tracklist');
    this.upcomingScrollEl = document.getElementById('upcoming-scroll');
    this.tracklistSection = document.getElementById('tracklist-section');
    this.introOverlay = document.getElementById('intro-overlay');

    this.init();
  }

  private async init() {
    // 1. Immediate State Check to prevent FOUC
    const urlParams = new URLSearchParams(window.location.search);
    const stateParam = urlParams.get('state');
    const isDocking = stateParam === 'animate_dock';
    const isRevealUI = stateParam === 'reveal_ui';

    if (isDocking || isRevealUI) {
      // HIDE UI SYNCHRONOUSLY
      const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;
      const controlBar = document.querySelector('.player-controls') as HTMLElement;
      const nav = document.querySelector('nav');

      if (tracklistSection) {
        tracklistSection.style.opacity = '0';
        tracklistSection.style.visibility = 'hidden';
      }
      if (controlBar) controlBar.style.opacity = '0';
      if (nav) nav.style.opacity = '0';
    }

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

    // Resume Sequence based on State
    if (isDocking) {
      this.startDockingSequence();
    } else if (isRevealUI) {
      this.revealUIAfterDock();
    } else if (urlParams.get('new_purchase') === 'true') {
      this.startIntroSequence();
    } else {
      this.setupInitialState();
    }

    // Initialize Unicorn Background
    // UnicornSceneManager.init('unicorn-background');
  }

  private setupInitialState() {
    // Hide tracklist and visualizer initially
    const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;

    if (tracklistSection) {
      tracklistSection.style.opacity = '1'; // Default visible unless animating
      tracklistSection.style.pointerEvents = 'auto';
      tracklistSection.style.transform = 'none';
      tracklistSection.style.transition = 'none';
    }

    // Run calibration spin on page load - wait for everything to be ready
    const waitForGsapAndRun = () => {
      const gsap = (window as any).gsap;
      const layer3 = document.querySelector('.animated-disk-player .layer-3');

      if (gsap && layer3) {
        console.log('GSAP and layer3 ready, starting calibration...');
        this.runCalibrationSpin();
      } else {
        console.log('Waiting for GSAP and layer3...', { gsap: !!gsap, layer3: !!layer3 });
        setTimeout(waitForGsapAndRun, 200);
      }
    };

    // Start checking after a short delay
    setTimeout(waitForGsapAndRun, 300);
  }

  private runCalibrationSpin() {
    const gsap = (window as any).gsap;
    const layer3 = document.querySelector('.animated-disk-player .layer-3') as HTMLElement;

    if (!layer3 || !gsap) return;

    // Play load audio (only if not already playing from docking sequence)
    if (!this.loadingAudio) {
      this.loadingAudio = new Audio('/assets/audio/dockload10sec.wav');
      this.loadingAudio.volume = 0.8;
    }
    if (this.loadingAudio.paused) {
      this.loadingAudio.currentTime = 0;
      this.loadingAudio.play().catch(e => console.error("Audio play failed", e));
    }

    // Force clear any CSS animation
    layer3.style.animation = 'none';
    layer3.style.animationPlayState = 'paused';
    layer3.style.willChange = 'transform';
    layer3.style.transformOrigin = 'center center';

    gsap.killTweensOf(layer3);
    gsap.set(layer3, { rotation: 0, transformOrigin: 'center center' });

    // Sequence: Slow stop fast spin stop to slow then fast spin
    const calibrationTl = gsap.timeline({
      onComplete: () => {
        // Auto play first track and continuous spin
        this.play();
      }
    });

    // 1. Slow spin (360 in 2s)
    calibrationTl.to(layer3, {
      rotation: "+=360", // Use relative rotation
      duration: 2,
      ease: 'linear'
    });

    // 2. Stop (Decelerate)
    calibrationTl.to(layer3, {
      rotation: '+=90',
      duration: 1,
      ease: 'power2.out'
    });

    // Pause briefly
    calibrationTl.to({}, { duration: 0.2 });

    // 3. Fast spin (720 in 1s)
    calibrationTl.to(layer3, {
      rotation: '+=720',
      duration: 1,
      ease: 'power2.inOut'
    });

    // 4. Stop (Decelerate fast)
    calibrationTl.to(layer3, {
      rotation: '+=180',
      duration: 0.5,
      ease: 'power2.out'
    });

    // Pause briefly
    calibrationTl.to({}, { duration: 0.2 });

    // 5. Slow (180 in 1.5s)
    calibrationTl.to(layer3, {
      rotation: '+=180',
      duration: 1.5,
      ease: 'linear'
    });

    // 6. Fast Spin (Accelerate into playback)
    // We accelerate and then the onComplete triggers this.play() which handles the infinite loop
    calibrationTl.to(layer3, {
      rotation: '+=360',
      duration: 0.5,
      ease: 'power1.in'
    });
  }

  private startDockingSequence() {
    const gsap = (window as any).gsap;
    if (!gsap) { this.setupInitialState(); return; }

    // 1. Hide UI elements initially — they'll slide in later
    const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;
    const controlBar = document.querySelector('.player-controls') as HTMLElement;
    const nowPlaying = document.querySelector('.now-playing') as HTMLElement;
    const nav = document.querySelector('nav');

    if (tracklistSection) {
      tracklistSection.style.opacity = '0';
      tracklistSection.style.visibility = 'hidden';
      gsap.set(tracklistSection, { x: 200 }); // Start off-screen right
    }
    if (controlBar) {
      controlBar.style.opacity = '0';
      gsap.set(controlBar, { y: 60 }); // Start below
    }
    if (nowPlaying) {
      nowPlaying.style.opacity = '0';
      gsap.set(nowPlaying, { y: 40 }); // Start below
    }
    if (nav) nav.style.opacity = '0';

    // 2. Create a simple black overlay that fades out
    const overlay = document.createElement('div');
    overlay.id = 'dock-overlay';
    overlay.style.position = 'fixed';
    overlay.style.inset = '0';
    overlay.style.background = '#000';
    overlay.style.zIndex = '9999';
    overlay.style.pointerEvents = 'none';
    document.body.appendChild(overlay);

    // Remove the instant black cover now that our overlay is in place
    const instantCover = document.getElementById('instant-black-cover');
    if (instantCover) instantCover.remove();

    // 3. Start loading sound immediately (while still black)
    if (!this.loadingAudio) {
      this.loadingAudio = new Audio('/assets/audio/dockload10sec.wav');
      this.loadingAudio.volume = 0.8;
    }
    this.loadingAudio.currentTime = 0;
    this.loadingAudio.play().catch(e => console.error("Audio play failed", e));

    // 4. Animate: fade from black → reveal page → slide in UI
    const tl = gsap.timeline();

    // Fade from black to reveal the stream page with player
    tl.to(overlay, {
      opacity: 0,
      duration: 1.2,
      ease: 'power2.out',
      onComplete: () => overlay.remove()
    });

    // Show nav
    if (nav) {
      tl.to(nav, { opacity: 1, duration: 0.4, ease: 'power2.out' }, '-=0.4');
    }

    // Slide tracklist in from the right
    if (tracklistSection) {
      tracklistSection.style.visibility = 'visible';
      tl.to(tracklistSection, {
        opacity: 1,
        x: 0,
        duration: 0.8,
        ease: 'power3.out'
      }, '-=0.3');
    }

    // Slide progress/controls up from below the player
    if (controlBar) {
      tl.to(controlBar, {
        opacity: 1,
        y: 0,
        duration: 0.6,
        ease: 'power3.out'
      }, '-=0.6');
    }

    // Slide now-playing info up from below the player
    if (nowPlaying) {
      tl.to(nowPlaying, {
        opacity: 1,
        y: 0,
        duration: 0.6,
        ease: 'power3.out'
      }, '-=0.5');
    }

    // 5. Start calibration spin (sound is already playing)
    tl.call(() => {
      this.runCalibrationSpin();
    }, [], '-=0.3');
  }

  private revealUIAfterDock() {
    // Remove instant black cover
    const instantCover = document.getElementById('instant-black-cover');
    if (instantCover) instantCover.remove();

    const gsap = (window as any).gsap;
    if (!gsap) {
      this.setupInitialState();
      return;
    }

    const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;
    const controlBar = document.querySelector('.player-controls') as HTMLElement;
    const nav = document.querySelector('nav');

    // Run calibration spin with audio
    this.runCalibrationSpin();

    // Immediate reveal - no delay, seamless transition from dock animation
    const tl = gsap.timeline();

    // Reveal everything quickly to show the player is ready
    if (nav) {
      tl.to(nav, {
        opacity: 1,
        duration: 0.3,
        ease: 'power2.out'
      });
    }

    // Reveal tracklist section
    if (tracklistSection) {
      tracklistSection.style.visibility = 'visible';
      tl.to(tracklistSection, {
        opacity: 1,
        duration: 0.4,
        ease: 'power2.out'
      }, '-=0.2');
    }

    // Reveal controls
    if (controlBar) {
      tl.to(controlBar, {
        opacity: 1,
        duration: 0.3,
        ease: 'power2.out'
      }, '-=0.3');
    }

    // Disc waits for song play after calibration
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
    // CD Player Button Overlays
    document.getElementById('cd-pause-btn')?.addEventListener('click', () => this.pause());
    document.getElementById('cd-stop-btn')?.addEventListener('click', () => this.stop());
    document.getElementById('cd-rewind-btn')?.addEventListener('click', () => this.rewind10());
    document.getElementById('cd-forward-btn')?.addEventListener('click', () => this.forward10());
    document.getElementById('cd-play-btn')?.addEventListener('click', () => this.play());
    document.getElementById('cd-repeat-btn')?.addEventListener('click', () => this.toggleRepeat());

    // Volume slider (integrated into CD player)
    const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
    volumeSlider?.addEventListener('input', (e) => {
      const value = parseInt((e.target as HTMLInputElement).value);
      this.setVolume(value / 100);
    });

    // Progress bar click
    this.progressBar?.addEventListener('click', (e) => this.seekTo(e));

    // Audio events
    this.audio.addEventListener('timeupdate', () => this.updateProgress());
    this.audio.addEventListener('ended', () => this.onTrackEnd());
    this.audio.addEventListener('loadedmetadata', () => this.updateTimeDisplay());

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => this.handleKeyboard(e));

    // Mobile tracklist toggle
    const tracklistHeader = document.getElementById('tracklist-header');
    tracklistHeader?.addEventListener('click', () => {
      this.tracklistSection?.classList.toggle('collapsed');
      this.tracklistSection?.classList.toggle('expanded');
    });
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

    // Render upcoming tracks preview
    this.renderUpcomingTracks();
  }

  private renderUpcomingTracks() {
    if (!this.upcomingScrollEl) return;

    // Get only the next track
    const nextIndex = (this.currentTrackIndex + 1) % this.tracks.length;
    const nextTrack = this.tracks[nextIndex];

    this.upcomingScrollEl.innerHTML = `
      <div class="upcoming-item" data-offset="1" data-index="${nextIndex}">
        <div class="upcoming-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
          </svg>
        </div>
        <div class="upcoming-info">
          <span class="upcoming-label-small">UP NEXT</span>
          <span class="upcoming-title">${nextTrack.title}</span>
          <span class="upcoming-duration">${nextTrack.duration}</span>
        </div>
        <div class="upcoming-chevron">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="9 18 15 12 9 6"></polyline>
          </svg>
        </div>
      </div>
    `;

    // Add click handler
    this.upcomingScrollEl.querySelector('.upcoming-item')?.addEventListener('click', () => {
      this.loadTrack(nextIndex);
      this.play();
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

    // Update upcoming tracks preview
    this.renderUpcomingTracks();

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
    if (this.tracks[this.currentTrackIndex].src) {
      this.audio.play().then(() => {
        this.onPlay();
      }).catch(console.error);
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

  private stop() {
    // Pause first (triggers deceleration)
    this.audio.pause();
    this.onPause();
    if (this.simulationInterval) {
      clearInterval(this.simulationInterval);
      this.simulationInterval = null;
    }
    // Reset to beginning
    this.audio.currentTime = 0;
    this.simulatedTime = 0;
    if (this.progressFill) this.progressFill.style.width = '0%';
    if (this.timeCurrent) this.timeCurrent.textContent = '0:00';
  }

  private rewind10() {
    const track = this.tracks[this.currentTrackIndex];
    if (track.src) {
      this.audio.currentTime = Math.max(0, this.audio.currentTime - 10);
    } else {
      this.simulatedTime = Math.max(0, this.simulatedTime - 10);
      const progress = (this.simulatedTime / track.durationSeconds) * 100;
      if (this.progressFill) this.progressFill.style.width = `${progress}%`;
      if (this.timeCurrent) this.timeCurrent.textContent = this.formatTime(this.simulatedTime);
    }
  }

  private forward10() {
    const track = this.tracks[this.currentTrackIndex];
    if (track.src) {
      this.audio.currentTime = Math.min(this.audio.duration, this.audio.currentTime + 10);
    } else {
      this.simulatedTime = Math.min(track.durationSeconds, this.simulatedTime + 10);
      const progress = (this.simulatedTime / track.durationSeconds) * 100;
      if (this.progressFill) this.progressFill.style.width = `${progress}%`;
      if (this.timeCurrent) this.timeCurrent.textContent = this.formatTime(this.simulatedTime);
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

    // Reveal UI if first play
    if (!this.hasStartedPlaying) {
      this.hasStartedPlaying = true;

      const tracklistSection = document.querySelector('.tracklist-section') as HTMLElement;
      const streamContainer = document.querySelector('.stream-container') as HTMLElement;

      if (streamContainer) {
        // Reset grid
        streamContainer.style.gridTemplateColumns = '1fr 400px';
        streamContainer.style.justifyItems = 'start';
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

    // Start disk animation
    this.diskAnimator?.setPlaying(true);
  }

  private onPause() {
    this.isPlaying = false;
    // Stop disk animation
    this.diskAnimator?.setPlaying(false);
  }

  private prevTrack() {
    let newIndex = this.currentTrackIndex - 1;
    if (newIndex < 0) newIndex = this.tracks.length - 1;

    this.simulatedTime = 0;
    this.loadTrack(newIndex);
    if (this.isPlaying) this.play();
  }

  private nextTrack() {
    let newIndex = this.currentTrackIndex + 1;
    if (newIndex >= this.tracks.length) newIndex = 0;

    this.simulatedTime = 0;
    this.loadTrack(newIndex);
    if (this.isPlaying) this.play();
  }

  private onTrackEnd() {
    if (this.repeatMode === 'one') {
      // Repeat current track
      this.audio.currentTime = 0;
      this.simulatedTime = 0;
      this.play();
    } else if (this.repeatMode === 'all') {
      // Auto-advance, loop at end of playlist
      this.nextTrack();
    } else {
      // No repeat - stop at end of playlist
      if (this.currentTrackIndex < this.tracks.length - 1) {
        this.nextTrack();
      } else {
        this.stop();
      }
    }
  }

  private toggleRepeat() {
    const btn = document.getElementById('cd-repeat-btn');

    // Cycle through: none -> all -> one -> none
    if (this.repeatMode === 'none') {
      this.repeatMode = 'all';
      btn?.classList.add('active');
      btn?.setAttribute('title', 'Repeat All');
    } else if (this.repeatMode === 'all') {
      this.repeatMode = 'one';
      btn?.classList.add('active', 'repeat-one');
      btn?.setAttribute('title', 'Repeat One');
    } else {
      this.repeatMode = 'none';
      btn?.classList.remove('active', 'repeat-one');
      btn?.setAttribute('title', 'Repeat Off');
    }
  }

  private setVolume(value: number) {
    this.audio.volume = value;
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
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new StreamPlayer();
  });
} else {
  new StreamPlayer();
}
