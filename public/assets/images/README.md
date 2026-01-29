# Album Artwork Guide

Place your album artwork images in this folder.

## Required Images

You need the following image files:

1. **pray-cover.jpg** - Main album cover (for the current playing track)
2. **the-source-cover.jpg** - Coming Soon album 1
3. **c-walk-cover.jpg** - Coming Soon album 2
4. **lit-cover.jpg** - Coming Soon album 3

## Image Specifications

### Recommended Specs
- **Format**: JPG or PNG (WebP recommended for better performance)
- **Dimensions**: 1000x1000px minimum
- **Aspect Ratio**: 1:1 (square)
- **File Size**: Under 500KB per image (optimized)
- **Color Space**: RGB

### Optimal Specs for Web
- **Format**: WebP with JPG fallback
- **Dimensions**: 1200x1200px
- **Quality**: 80-85%
- **File Size**: 100-300KB

## How to Use Your Own Images

### Option 1: Simple Replacement
1. Prepare your square album artwork images
2. Name them exactly as listed above
3. Copy them into this folder (`assets/images/`)
4. Refresh your browser

### Option 2: Using Different Names
If your images have different names:

1. Update the image paths in `index.html`:
   ```html
   <!-- Find and update these lines -->
   <img src="assets/images/your-custom-name.jpg" alt="...">
   ```

2. Update the playlist in `js/player.js`:
   ```javascript
   this.playlist = [
       {
           title: 'Pray',
           artist: 'ThaMyind',
           src: 'assets/audio/pray.mp3',
           cover: 'assets/images/your-custom-name.jpg' // Update this
       }
   ];
   ```

## Using the Provided Screenshot

The screenshot from your design (`Screenshot 2025-11-12 at 9.38.46 AM.png`) is in the parent folder. You can:

1. **Extract the album art** from the screenshot using any image editor
2. **Crop to square** (1:1 aspect ratio)
3. **Save as** one of the required filenames above
4. **Place in this folder**

## Temporary Placeholders

For testing, you can use:
- Solid color squares (create in any image editor)
- Stock images from [Unsplash](https://unsplash.com) or [Pexels](https://pexels.com)
- AI-generated artwork
- Simple text-based images

## Optimizing Images

### Using Online Tools
- **TinyPNG**: https://tinypng.com (drag & drop, automatic optimization)
- **Squoosh**: https://squoosh.app (advanced options, by Google)
- **ImageOptim**: https://imageoptim.com (Mac app)

### Using Command Line

**ImageMagick** (resize and optimize):
```bash
# Install ImageMagick first
# macOS: brew install imagemagick
# Linux: apt-get install imagemagick

# Resize and optimize
convert input.jpg -resize 1000x1000 -quality 85 pray-cover.jpg
```

**cwebp** (convert to WebP):
```bash
# Install webp tools
# macOS: brew install webp
# Linux: apt-get install webp

# Convert to WebP
cwebp pray-cover.jpg -q 80 -o pray-cover.webp
```

## Creating WebP with Fallback

For best performance, use WebP format with JPG fallback:

1. Convert your images to WebP
2. Keep JPG versions
3. Update HTML to use both:

```html
<picture>
    <source srcset="assets/images/pray-cover.webp" type="image/webp">
    <img src="assets/images/pray-cover.jpg" alt="Pray album cover">
</picture>
```

## Troubleshooting

### Images Not Showing
- Check file names match exactly (case-sensitive)
- Verify files are in the correct folder
- Check file extensions (.jpg, .png, not .jpeg)
- Clear browser cache (Ctrl+Shift+R or Cmd+Shift+R)

### Images Look Blurry
- Increase dimensions (minimum 1000x1000px)
- Reduce compression quality slightly
- Check source image quality

### Large File Sizes
- Optimize using tools mentioned above
- Target 100-300KB per image
- Use WebP format (30-50% smaller than JPG)

## Design Tips

### For Album Artwork
- Use high-contrast images for better visibility on dark background
- Ensure text in artwork is readable at small sizes
- Test how it looks with the glassmorphism effect
- Square format is required (1:1 aspect ratio)

### Color Coordination
The site uses these colors:
- Background: Dark (#1a1c26, #2a2d3a)
- Accent: Gold (#d4af37)
- Text: White (#ffffff)

Choose artwork that complements these colors.

## Examples

### Good Artwork Characteristics
✓ High resolution (1000x1000px+)
✓ Clear subject/focus
✓ Good contrast
✓ Optimized file size
✓ Square aspect ratio

### Avoid
✗ Low resolution/pixelated
✗ Stretched or distorted
✗ Large file sizes (>1MB)
✗ Non-square aspect ratios

## Resources

### Free Stock Images
- [Unsplash](https://unsplash.com) - High-quality free photos
- [Pexels](https://pexels.com) - Free stock photos
- [Pixabay](https://pixabay.com) - Free images and vectors

### Design Tools
- [Canva](https://canva.com) - Easy album cover creation
- [Figma](https://figma.com) - Professional design tool
- [Photopea](https://photopea.com) - Free Photoshop alternative

### AI Image Generation
- [Midjourney](https://midjourney.com) - AI art generation
- [DALL-E](https://openai.com/dall-e) - AI image creation
- [Stable Diffusion](https://stablediffusionweb.com) - Free AI art

---

**Need help?** Refer to the main README.md in the project root.

**Built for ThaMyind / Myind Sound**
