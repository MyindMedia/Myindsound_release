# Audio Files Guide

Place your music files in this folder.

## Required Audio File

You need at least one audio file:

- **pray.mp3** - Your main track

## Audio Specifications

### Recommended Specs
- **Format**: MP3 (best browser compatibility)
- **Bitrate**: 192-320 kbps
- **Sample Rate**: 44.1 kHz
- **Channels**: Stereo
- **File Size**: 3-10 MB per song (depending on length)

### Alternative Formats (with fallback)
You can also provide multiple formats for better compatibility:
- **MP3** - Best compatibility (all browsers)
- **OGG** - Good for Firefox, Chrome
- **AAC/M4A** - Good for Safari, iOS

## How to Add Your Music

### Single File (Easiest)
1. Name your audio file: `pray.mp3`
2. Copy it to this folder (`assets/audio/`)
3. Refresh your browser

### Multiple Files
To add more songs to the playlist:

1. Add your audio files to this folder
2. Update `js/player.js` (around line 46):

```javascript
this.playlist = [
    {
        title: 'Pray',
        artist: 'ThaMyind',
        src: 'assets/audio/pray.mp3',
        cover: 'assets/images/pray-cover.jpg'
    },
    {
        title: 'Your New Song',
        artist: 'ThaMyind',
        src: 'assets/audio/your-new-song.mp3',
        cover: 'assets/images/your-new-song-cover.jpg'
    }
];
```

## Audio Format Support

### Browser Compatibility

| Format | Chrome | Firefox | Safari | Edge |
|--------|--------|---------|--------|------|
| MP3    | ✓      | ✓       | ✓      | ✓    |
| OGG    | ✓      | ✓       | ✗      | ✓    |
| AAC    | ✓      | ✗       | ✓      | ✓    |
| WAV    | ✓      | ✓       | ✓      | ✓    |

**Recommendation**: Use MP3 for universal compatibility.

### Using Multiple Formats

Update `index.html` for multiple format support:

```html
<audio id="audioPlayer" preload="auto">
    <source src="assets/audio/pray.mp3" type="audio/mpeg">
    <source src="assets/audio/pray.ogg" type="audio/ogg">
    <source src="assets/audio/pray.m4a" type="audio/aac">
    Your browser does not support the audio element.
</audio>
```

## Converting Audio Files

### Online Tools
- **CloudConvert**: https://cloudconvert.com/mp3-converter
- **Online Audio Converter**: https://online-audio-converter.com
- **Convertio**: https://convertio.co/audio-converter

### Desktop Software

**Audacity (Free, Cross-platform)**
1. Download from https://audacityteam.org
2. Open your audio file
3. File → Export → Export as MP3
4. Set quality: 192-320 kbps

**FFmpeg (Command line)**
```bash
# Install FFmpeg first
# macOS: brew install ffmpeg
# Linux: apt-get install ffmpeg

# Convert to MP3
ffmpeg -i input.wav -b:a 192k pray.mp3

# Convert and optimize
ffmpeg -i input.wav -b:a 192k -ar 44100 pray.mp3
```

## Optimizing Audio

### Bitrate Guide
- **128 kbps** - Acceptable quality, smaller file
- **192 kbps** - Good quality, recommended minimum
- **256 kbps** - Very good quality
- **320 kbps** - Highest quality, larger file

### Recommended: 192 kbps
Good balance between quality and file size.

### Command Line Optimization

**Using FFmpeg:**
```bash
# Optimize to 192 kbps
ffmpeg -i pray.mp3 -b:a 192k -ar 44100 pray-optimized.mp3

# Normalize audio levels
ffmpeg -i pray.mp3 -af loudnorm pray-normalized.mp3
```

## Audio Metadata

Add metadata to your MP3 files for better organization:

### Using iTunes/Music App
1. Right-click the file
2. Get Info → Details
3. Fill in:
   - Title: Pray
   - Artist: ThaMyind
   - Album: Your Album Name
   - Genre: Gospel/Christian/Hip-Hop
   - Year: 2025

### Using FFmpeg
```bash
ffmpeg -i input.mp3 -metadata title="Pray" -metadata artist="ThaMyind" \
       -metadata album="Your Album" -metadata year="2025" \
       -codec copy pray.mp3
```

## Troubleshooting

### Audio Not Playing
- Verify file exists in `assets/audio/` folder
- Check file is named exactly `pray.mp3`
- Ensure file is valid MP3 format
- Check browser console for errors (F12)
- Some browsers block autoplay (this is normal - requires user click)

### Audio Cuts Out or Skips
- File may be corrupted - re-export
- Bitrate may be too high - try 192 kbps
- Check for disk space issues
- Try a different browser

### Wrong Duration Showing
- File metadata may be incorrect
- Re-export with proper encoding
- Use FFmpeg to fix:
  ```bash
  ffmpeg -i input.mp3 -codec copy output.mp3
  ```

### Poor Audio Quality
- Increase bitrate (256 or 320 kbps)
- Use higher quality source file
- Check original recording quality

## File Size Guidelines

For a 3-minute song:
- 128 kbps: ~3 MB
- 192 kbps: ~4.5 MB
- 256 kbps: ~6 MB
- 320 kbps: ~7.5 MB

**Recommended**: Keep files under 10 MB for faster loading.

## Streaming vs. Download

The player uses HTML5 audio with:
- **Preload**: Audio metadata loads on page load
- **Progressive Download**: Song downloads as it plays
- **Buffering**: Browser automatically buffers ahead

No streaming server required - files are served directly from your web host.

## Mobile Considerations

### iOS Restrictions
- Autoplay is disabled (user must click play)
- Background audio may pause when switching apps
- Some formats may not work (stick to MP3)

### Android
- Generally good support for all formats
- Autoplay may be restricted
- Background audio typically works

**Solution**: Always require user interaction (click) before playing - already implemented in the email capture flow.

## Testing

### Before Deploying
- [ ] Audio file is in `assets/audio/` folder
- [ ] File is named `pray.mp3`
- [ ] File plays in browser (test in Chrome, Firefox, Safari)
- [ ] File size is reasonable (<10 MB)
- [ ] Audio quality sounds good
- [ ] Metadata is correct (title, artist)

### After Deploying
- [ ] Test on desktop
- [ ] Test on mobile (iOS and Android)
- [ ] Test progress bar updates correctly
- [ ] Test on different browsers
- [ ] Check audio doesn't lag or skip

## Advanced: Adding Waveform Visualization

Want to show a waveform? You can use libraries like:
- **Wavesurfer.js**: https://wavesurfer-js.org
- **Peaks.js**: https://github.com/bbc/peaks.js

This is optional and not included by default.

## Copyright Notice

**Important**: Ensure you have the rights to distribute the audio files on your website. This includes:
- Music you created yourself ✓
- Music you have distribution rights for ✓
- Licensed music with web streaming rights ✓
- Copyrighted music without permission ✗

## Resources

### Audio Editing
- **Audacity**: https://audacityteam.org (Free, open-source)
- **GarageBand**: https://apple.com/mac/garageband (Free, Mac only)
- **Adobe Audition**: https://adobe.com/products/audition (Professional)

### Audio Hosting (Alternative)
If you prefer to host audio externally:
- **SoundCloud**: https://soundcloud.com
- **Cloudinary**: https://cloudinary.com
- **AWS S3**: https://aws.amazon.com/s3

Update the `src` in your playlist to point to the external URL.

---

**Need help?** Refer to the main README.md in the project root.

**Built for ThaMyind / Myind Sound**
