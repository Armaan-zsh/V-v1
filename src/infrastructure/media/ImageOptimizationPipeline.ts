import sharp from 'sharp';
import { createHash } from 'crypto';
import { Redis } from '@upstash/redis';

export interface ImageOptimizationConfig {
  redis: Redis;
  quality: {
    thumbnail: number;
    preview: number;
    original: number;
  };
  sizes: {
    thumbnail: [number, number];
    small: [number, number];
    medium: [number, number];
    large: [number, number];
    xl: [number, number];
  };
  formats: ('webp' | 'avif' | 'jpeg' | 'png')[];
  cacheTtl: number;
  maxFileSize: number;
}

export interface ImageMetadata {
  id: string;
  originalName: string;
  format: string;
  size: number;
  dimensions: {
    width: number;
    height: number;
  };
  hash: string;
  optimizedVariants: OptimizedVariant[];
  createdAt: Date;
  metadata: {
    dominantColor?: string;
    exif?: any;
    hasTransparency: boolean;
    isAnimated: boolean;
  };
}

export interface OptimizedVariant {
  width: number;
  height: number;
  format: string;
  quality: number;
  size: number;
  url: string;
  cdnUrl?: string;
}

export interface OptimizationResult {
  success: boolean;
  metadata: ImageMetadata;
  error?: string;
}

export class ImageOptimizationPipeline {
  private redis: Redis;
  private config: ImageOptimizationConfig;

  constructor(config: ImageOptimizationConfig) {
    this.redis = config.redis;
    this.config = config;
  }

  /**
   * Process uploaded image with full optimization pipeline
   */
  async processImage(
    inputBuffer: Buffer,
    originalName: string,
    metadata?: any
  ): Promise<OptimizationResult> {
    try {
      // 1. Validate image
      const validation = await this.validateImage(inputBuffer);
      if (!validation.valid) {
        throw new Error(`Invalid image: ${validation.error}`);
      }

      // 2. Generate unique hash and ID
      const imageHash = createHash('sha256').update(inputBuffer).digest('hex');
      const imageId = `img_${Date.now()}_${imageHash.slice(0, 8)}`;

      // 3. Get original image info
      const original = await sharp(inputBuffer).metadata();
      if (!original.width || !original.height) {
        throw new Error('Unable to read image dimensions');
      }

      // 4. Extract metadata
      const extractedMetadata = await this.extractMetadata(inputBuffer, original);

      // 5. Generate optimized variants
      const optimizedVariants = await this.generateOptimizedVariants(
        inputBuffer,
        imageId,
        original
      );

      // 6. Build metadata object
      const imageMetadata: ImageMetadata = {
        id: imageId,
        originalName,
        format: original.format || 'unknown',
        size: inputBuffer.length,
        dimensions: {
          width: original.width,
          height: original.height
        },
        hash: imageHash,
        optimizedVariants,
        createdAt: new Date(),
        metadata: extractedMetadata
      };

      // 7. Cache metadata
      await this.cacheMetadata(imageMetadata);

      // 8. Pre-generate responsive sizes if needed
      await this.pregenerateResponsiveSizes(imageMetadata);

      return {
        success: true,
        metadata: imageMetadata
      };

    } catch (error) {
      console.error('Image processing error:', error);
      return {
        success: false,
        metadata: {} as ImageMetadata,
        error: error instanceof Error ? error.message : 'Unknown error'
      };
    }
  }

  /**
   * Generate multiple optimized variants from source image
   */
  private async generateOptimizedVariants(
    inputBuffer: Buffer,
    imageId: string,
    original: sharp.Metadata
  ): Promise<OptimizedVariant[]> {
    const variants: OptimizedVariant[] = [];

    for (const sizeKey of Object.keys(this.config.sizes) as Array<keyof typeof this.config.sizes>) {
      const [targetWidth, targetHeight] = this.config.sizes[sizeKey];
      
      // Calculate resize dimensions maintaining aspect ratio
      const resizeOptions = this.calculateResizeOptions(
        original.width!,
        original.height!,
        targetWidth,
        targetHeight
      );

      for (const format of this.config.formats) {
        const quality = this.getQualityForSize(sizeKey, format);
        
        try {
          const optimizedBuffer = await this.optimizeImage(
            inputBuffer,
            resizeOptions,
            format,
            quality
          );

          const variant: OptimizedVariant = {
            width: resizeOptions.width,
            height: resizeOptions.height,
            format,
            quality,
            size: optimizedBuffer.length,
            url: `/api/images/${imageId}/${sizeKey}.${format}`,
            cdnUrl: this.getCDNUrl(imageId, sizeKey, format)
          };

          variants.push(variant);

          // Store optimized image in cache/storage
          await this.storeOptimizedImage(imageId, sizeKey, format, optimizedBuffer);

        } catch (error) {
          console.error(`Failed to generate ${sizeKey}.${format}:`, error);
        }
      }
    }

    return variants;
  }

  /**
   * Resize image with smart cropping and optimization
   */
  private calculateResizeOptions(
    originalWidth: number,
    originalHeight: number,
    targetWidth: number,
    targetHeight: number
  ): sharp.ResizeOptions {
    const aspectRatio = targetWidth / targetHeight;
    const originalAspectRatio = originalWidth / originalHeight;

    let width = targetWidth;
    let height = targetHeight;
    let position: sharp.Gravity | sharp.Strategy = 'centre';

    if (Math.abs(originalAspectRatio - aspectRatio) > 0.1) {
      // Significant aspect ratio difference - use smart cropping
      if (originalAspectRatio > aspectRatio) {
        // Image is wider - crop width
        width = Math.round(targetHeight * originalAspectRatio);
        position = 'centre';
      } else {
        // Image is taller - crop height
        height = Math.round(targetWidth / originalAspectRatio);
        position = 'centre';
      }
    }

    return {
      width,
      height,
      fit: 'cover',
      position,
      withoutEnlargement: true
    };
  }

  /**
   * Optimize image with format-specific settings
   */
  private async optimizeImage(
    inputBuffer: Buffer,
    resizeOptions: sharp.ResizeOptions,
    format: string,
    quality: number
  ): Promise<Buffer> {
    let pipeline = sharp(inputBuffer).resize(resizeOptions);

    switch (format) {
      case 'webp':
        pipeline = pipeline.webp({
          quality,
          effort: 4,
          smartSubsample: true
        });
        break;

      case 'avif':
        pipeline = pipeline.avif({
          quality,
          effort: 4
        });
        break;

      case 'jpeg':
        pipeline = pipeline.jpeg({
          quality,
          mozjpeg: true,
          chromaSubsampling: '4:2:0'
        });
        break;

      case 'png':
        pipeline = pipeline.png({
          quality,
          compressionLevel: 9,
          palette: true
        });
        break;
    }

    return await pipeline.toBuffer();
  }

  /**
   * Get quality setting based on size and format
   */
  private getQualityForSize(sizeKey: keyof typeof this.config.sizes, format: string): number {
    const baseQuality = this.config.quality.original;

    switch (sizeKey) {
      case 'thumbnail':
        return Math.min(baseQuality - 20, 60);
      case 'small':
        return Math.min(baseQuality - 10, 70);
      case 'medium':
        return baseQuality;
      case 'large':
        return Math.min(baseQuality + 5, 95);
      case 'xl':
        return baseQuality;
      default:
        return baseQuality;
    }
  }

  /**
   * Extract additional metadata from image
   */
  private async extractMetadata(inputBuffer: Buffer, sharpMetadata: sharp.Metadata): Promise<any> {
    const metadata: any = {
      hasTransparency: false,
      isAnimated: false
    };

    try {
      // Check for transparency
      const channels = sharpMetadata.channels || 0;
      if (channels === 4) {
        // Has alpha channel - could have transparency
        const alphaStats = await sharp(inputBuffer).stats();
        const maxAlpha = Math.max(...alphaStats.channels.map(c => c.max || 0));
        metadata.hasTransparency = maxAlpha < 255;
      }

      // Extract EXIF data
      const exifData = await this.extractExifData(inputBuffer);
      if (exifData) {
        metadata.exif = exifData;
      }

      // Get dominant color
      const dominantColor = await this.getDominantColor(inputBuffer);
      if (dominantColor) {
        metadata.dominantColor = dominantColor;
      }

    } catch (error) {
      console.error('Metadata extraction error:', error);
    }

    return metadata;
  }

  /**
   * Extract EXIF data from image
   */
  private async extractExifData(inputBuffer: Buffer): Promise<any> {
    try {
      const { exif } = await sharp(inputBuffer).metadata();
      if (exif) {
        // Parse EXIF data (simplified)
        const exifString = exif.toString('utf8');
        return {
          raw: exifString,
          camera: this.parseExifCamera(exifString),
          gps: this.parseExifGPS(exifString),
          timestamp: this.parseExifTimestamp(exifString)
        };
      }
    } catch (error) {
      console.error('EXIF extraction error:', error);
    }
    return null;
  }

  /**
   * Get dominant color from image
   */
  private async getDominantColor(inputBuffer: Buffer): Promise<string | null> {
    try {
      const { dominant } = await sharp(inputBuffer)
        .resize(1, 1)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      return `#${dominant.r.toString(16).padStart(2, '0')}${dominant.g.toString(16).padStart(2, '0')}${dominant.b.toString(16).padStart(2, '0')}`;
    } catch (error) {
      console.error('Dominant color extraction error:', error);
      return null;
    }
  }

  /**
   * Validate uploaded image
   */
  private async validateImage(inputBuffer: Buffer): Promise<{ valid: boolean; error?: string }> {
    try {
      // Check file size
      if (inputBuffer.length > this.config.maxFileSize) {
        return {
          valid: false,
          error: `File too large: ${inputBuffer.length} bytes (max: ${this.config.maxFileSize})`
        };
      }

      // Check if it's a valid image
      const metadata = await sharp(inputBuffer).metadata();
      
      if (!metadata.width || !metadata.height) {
        return {
          valid: false,
          error: 'Invalid image format'
        };
      }

      // Check supported formats
      const supportedFormats = ['jpeg', 'jpg', 'png', 'webp', 'gif', 'tiff', 'svg'];
      if (!metadata.format || !supportedFormats.includes(metadata.format)) {
        return {
          valid: false,
          error: `Unsupported format: ${metadata.format}`
        };
      }

      return { valid: true };

    } catch (error) {
      return {
        valid: false,
        error: 'Failed to process image'
      };
    }
  }

  /**
   * Cache image metadata
   */
  private async cacheMetadata(metadata: ImageMetadata): Promise<void> {
    const cacheKey = `image:metadata:${metadata.id}`;
    await this.redis.setex(cacheKey, this.config.cacheTtl, JSON.stringify(metadata));
  }

  /**
   * Store optimized image variant
   */
  private async storeOptimizedImage(
    imageId: string,
    sizeKey: string,
    format: string,
    buffer: Buffer
  ): Promise<void> {
    const cacheKey = `image:variant:${imageId}:${sizeKey}:${format}`;
    await this.redis.setex(cacheKey, this.config.cacheTtl, buffer.toString('base64'));
  }

  /**
   * Generate responsive image sources
   */
  generateResponsiveSources(metadata: ImageMetadata): string[] {
    const sources: string[] = [];
    
    for (const variant of metadata.optimizedVariants) {
      if (variant.format === 'webp' || variant.format === 'avif') {
        sources.push(`${variant.url} (${variant.format})`);
      }
    }
    
    return sources;
  }

  /**
   * Get CDN URL for optimized image
   */
  private getCDNUrl(imageId: string, sizeKey: string, format: string): string {
    // TODO: Implement actual CDN integration (Cloudflare, AWS CloudFront, etc.)
    return `https://cdn.vow.com/images/${imageId}/${sizeKey}.${format}`;
  }

  // Helper methods for EXIF parsing
  private parseExifCamera(exifData: string): string | null {
    // Simplified EXIF parsing
    const cameraMatch = exifData.match(/Camera.*?:([^\n]+)/);
    return cameraMatch ? cameraMatch[1].trim() : null;
  }

  private parseExifGPS(exifData: string): any | null {
    // Simplified GPS parsing
    const gpsMatch = exifData.match(/GPS.*?:([^\n]+)/);
    return gpsMatch ? { raw: gpsMatch[1].trim() } : null;
  }

  private parseExifTimestamp(exifData: string): string | null {
    const timestampMatch = exifData.match(/Date.*?:([^\n]+)/);
    return timestampMatch ? timestampMatch[1].trim() : null;
  }

  /**
   * Pre-generate responsive sizes for critical images
   */
  private async pregenerateResponsiveSizes(metadata: ImageMetadata): Promise<void> {
    // For images marked as critical, pre-generate additional responsive sizes
    const criticalSizes = ['webp', 'avif'];
    
    for (const variant of metadata.optimizedVariants) {
      if (criticalSizes.includes(variant.format)) {
        // Pre-generate srcset for responsive images
        await this.generateSrcSet(metadata.id, variant.format);
      }
    }
  }

  /**
   * Generate srcset for responsive images
   */
  private async generateSrcSet(imageId: string, format: string): Promise<string> {
    const sizes = ['320w', '640w', '768w', '1024w', '1280w', '1920w'];
    const srcsetEntries: string[] = [];

    for (const size of sizes) {
      const [width] = size.split('w');
      const variantUrl = `/api/images/${imageId}/${width}.${format}`;
      srcsetEntries.push(`${variantUrl} ${size}`);
    }

    return srcsetEntries.join(', ');
  }
}

// Factory function to create pipeline
export function createImagePipeline(redis: Redis): ImageOptimizationPipeline {
  return new ImageOptimizationPipeline({
    redis,
    quality: {
      thumbnail: 60,
      preview: 75,
      original: 85
    },
    sizes: {
      thumbnail: [150, 150],
      small: [300, 200],
      medium: [600, 400],
      large: [1200, 800],
      xl: [1920, 1280]
    },
    formats: ['webp', 'avif', 'jpeg'],
    cacheTtl: 86400 * 30, // 30 days
    maxFileSize: 10 * 1024 * 1024 // 10MB
  });
}