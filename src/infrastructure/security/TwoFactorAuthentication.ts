import { PrismaClient } from '@prisma/client';
import { Redis } from '@upstash/redis';
import { generateTOTP, verifyTOTP } from 'otplib';
import * as QRCode from 'qrcode';
import * as speakeasy from 'speakeasy';
import { nanoid } from 'nanoid';

export interface TwoFactorConfig {
  redis: Redis;
  prisma: PrismaClient;
  issuer: string;
  window: number; // Time window for TOTP verification
  backupCodes: number; // Number of backup codes to generate
  rateLimit: {
    attempts: number;
    window: string;
  };
  methods: ('totp' | 'sms' | 'email')[];
}

export interface TwoFactorBackup {
  id: string;
  code: string;
  used: boolean;
  usedAt?: Date;
  createdAt: Date;
}

export interface TwoFactorMethod {
  id: string;
  type: 'totp' | 'sms' | 'email';
  name: string;
  secret?: string;
  verified: boolean;
  enabled: boolean;
  backupCodes?: TwoFactorBackup[];
  metadata: {
    phone?: string;
    email?: string;
    deviceName?: string;
    lastUsed?: Date;
  };
}

export interface TwoFactorSetup {
  secret: string;
  qrCodeUrl: string;
  backupCodes: string[];
  tempToken: string;
}

export class TwoFactorAuthentication {
  private redis: Redis;
  private prisma: PrismaClient;
  private config: TwoFactorConfig;

  constructor(config: TwoFactorConfig) {
    this.redis = config.redis;
    this.prisma = config.prisma;
    this.config = config;
  }

  /**
   * Setup TOTP 2FA for a user
   */
  async setupTOTP(userId: string, deviceName?: string): Promise<TwoFactorSetup> {
    try {
      // Generate secret
      const secret = speakeasy.generateSecret({
        name: `${this.config.issuer} (${userId})`,
        length: 32,
        issuer: this.config.issuer
      });

      // Generate QR code
      const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url!);

      // Generate backup codes
      const backupCodes = this.generateBackupCodes();

      // Store temporary setup data
      const tempToken = nanoid(32);
      const setupData = {
        secret: secret.base32,
        qrCodeUrl,
        backupCodes,
        userId,
        deviceName,
        expiresAt: Date.now() + (10 * 60 * 1000) // 10 minutes
      };

      await this.redis.setex(
        `2fa:setup:${tempToken}`,
        600, // 10 minutes
        JSON.stringify(setupData)
      );

      return {
        secret: secret.base32,
        qrCodeUrl,
        backupCodes,
        tempToken
      };

    } catch (error) {
      console.error('TOTP setup error:', error);
      throw new Error('Failed to setup 2FA');
    }
  }

  /**
   * Verify and enable 2FA for user
   */
  async verifyAndEnable(
    userId: string,
    tempToken: string,
    verificationCode: string
  ): Promise<{ success: boolean; recoveryCodes: string[] }> {
    try {
      // Get setup data
      const setupData = await this.redis.get(`2fa:setup:${tempToken}`);
      if (!setupData) {
        throw new Error('Setup token expired or invalid');
      }

      const setup = JSON.parse(setupData as string);
      
      // Verify the TOTP code
      const verified = speakeasy.totp.verify({
        secret: setup.secret,
        encoding: 'base32',
        token: verificationCode,
        window: this.config.window
      });

      if (!verified) {
        throw new Error('Invalid verification code');
      }

      // Store 2FA method in database
      const method: TwoFactorMethod = {
        id: nanoid(),
        type: 'totp',
        name: setup.deviceName || 'Default Device',
        secret: setup.secret,
        verified: true,
        enabled: true,
        backupCodes: setup.backupCodes.map(code => ({
          id: nanoid(),
          code,
          used: false,
          createdAt: new Date()
        })),
        metadata: {
          deviceName: setup.deviceName,
          lastUsed: new Date()
        }
      };

      // Save to database (assuming we have a User2FA table)
      await this.saveTwoFactorMethod(userId, method);

      // Clean up temporary data
      await this.redis.del(`2fa:setup:${tempToken}`);

      // Return recovery codes (show only once)
      return {
        success: true,
        recoveryCodes: setup.backupCodes
      };

    } catch (error) {
      console.error('2FA verification error:', error);
      throw error;
    }
  }

  /**
   * Verify 2FA code during login
   */
  async verifyCode(
    userId: string,
    code: string,
    backupCodeUsed: boolean = false
  ): Promise<{ success: boolean; method?: string }> {
    try {
      // Rate limiting check
      const rateLimitKey = `2fa:rate_limit:${userId}`;
      const rateLimitResult = await this.checkRateLimit(rateLimitKey);
      
      if (!rateLimitResult.allowed) {
        throw new Error('Too many attempts. Please try again later.');
      }

      // Get user's 2FA methods
      const methods = await this.getTwoFactorMethods(userId);
      const enabledMethods = methods.filter(m => m.enabled && m.verified);

      if (enabledMethods.length === 0) {
        throw new Error('2FA not enabled for this user');
      }

      // Try backup codes first if specified
      if (backupCodeUsed) {
        const backupResult = await this.verifyBackupCode(userId, code);
        if (backupResult.success) {
          return { success: true, method: 'backup' };
        }
        throw new Error('Invalid backup code');
      }

      // Try each enabled method
      for (const method of enabledMethods) {
        const result = await this.verifyMethodCode(method, code);
        if (result.success) {
          // Update last used timestamp
          await this.updateMethodLastUsed(userId, method.id);
          return { success: true, method: method.type };
        }
      }

      throw new Error('Invalid verification code');

    } catch (error) {
      console.error('2FA verification error:', error);
      throw error;
    }
  }

  /**
   * Verify specific 2FA method
   */
  private async verifyMethodCode(method: TwoFactorMethod, code: string): Promise<{ success: boolean }> {
    switch (method.type) {
      case 'totp':
        return {
          success: speakeasy.totp.verify({
            secret: method.secret!,
            encoding: 'base32',
            token: code,
            window: this.config.window
          })
        };

      case 'sms':
        // TODO: Implement SMS verification
        return { success: false };

      case 'email':
        // TODO: Implement email verification
        return { success: false };

      default:
        return { success: false };
    }
  }

  /**
   * Verify backup code
   */
  private async verifyBackupCode(userId: string, code: string): Promise<{ success: boolean }> {
    // This would check against stored backup codes
    // Implementation depends on database schema
    return { success: false }; // Placeholder
  }

  /**
   * Get user's 2FA methods
   */
  private async getTwoFactorMethods(userId: string): Promise<TwoFactorMethod[]> {
    // This would query the database for user's 2FA methods
    // Placeholder implementation
    return [];
  }

  /**
   * Save 2FA method to database
   */
  private async saveTwoFactorMethod(userId: string, method: TwoFactorMethod): Promise<void> {
    // This would save to database
    // Implementation depends on actual database schema
    console.log(`Saving 2FA method for user ${userId}:`, method);
  }

  /**
   * Update method last used timestamp
   */
  private async updateMethodLastUsed(userId: string, methodId: string): Promise<void> {
    const cacheKey = `2fa:method:${userId}:${methodId}`;
    const method = await this.redis.get(cacheKey);
    
    if (method) {
      const updated = JSON.parse(method as string);
      updated.metadata.lastUsed = new Date();
      await this.redis.setex(cacheKey, 86400, JSON.stringify(updated));
    }
  }

  /**
   * Check rate limiting
   */
  private async checkRateLimit(key: string): Promise<{ allowed: boolean; remaining: number }> {
    const redis = new (require('@upstash/ratelimit')).Ratelimit({
      redis: this.redis,
      limiter: (require('@upstash/ratelimit')).Ratelimit.slidingWindow(
        this.config.rateLimit.attempts,
        this.config.rateLimit.window
      )
    });

    return await redis.limit(key);
  }

  /**
   * Generate backup codes
   */
  private generateBackupCodes(count: number = this.config.backupCodes): string[] {
    const codes: string[] = [];
    
    for (let i = 0; i < count; i++) {
      // Generate a secure random code
      const code = nanoid(10).toUpperCase().replace(/(.{4})/g, '$1-').slice(0, -1);
      codes.push(code);
    }
    
    return codes;
  }

  /**
   * Disable 2FA for user
   */
  async disable(userId: string, verificationCode: string): Promise<{ success: boolean }> {
    try {
      // Verify current 2FA code
      await this.verifyCode(userId, verificationCode);
      
      // Remove all 2FA methods from database
      await this.removeAllTwoFactorMethods(userId);
      
      // Clear cache
      await this.clearTwoFactorCache(userId);
      
      return { success: true };

    } catch (error) {
      console.error('Disable 2FA error:', error);
      throw error;
    }
  }

  /**
   * Remove all 2FA methods for user
   */
  private async removeAllTwoFactorMethods(userId: string): Promise<void> {
    // Implementation depends on database schema
    console.log(`Removing all 2FA methods for user ${userId}`);
  }

  /**
   * Clear 2FA cache for user
   */
  private async clearTwoFactorCache(userId: string): Promise<void> {
    const keys = await this.redis.keys(`2fa:*:${userId}*`);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  /**
   * Send SMS verification code
   */
  async sendSMSCode(phone: string): Promise<{ success: boolean; tempToken: string }> {
    try {
      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store verification code
      const tempToken = nanoid(32);
      await this.redis.setex(`2fa:sms:${tempToken}`, 300, JSON.stringify({ code, phone }));
      
      // Send SMS (placeholder - integrate with SMS service)
      console.log(`SMS code for ${phone}: ${code}`);
      
      return { success: true, tempToken };

    } catch (error) {
      console.error('SMS send error:', error);
      throw new Error('Failed to send verification code');
    }
  }

  /**
   * Send email verification code
   */
  async sendEmailCode(email: string): Promise<{ success: boolean; tempToken: string }> {
    try {
      // Generate 6-digit code
      const code = Math.floor(100000 + Math.random() * 900000).toString();
      
      // Store verification code
      const tempToken = nanoid(32);
      await this.redis.setex(`2fa:email:${tempToken}`, 300, JSON.stringify({ code, email }));
      
      // Send email (placeholder - integrate with email service)
      console.log(`Email code for ${email}: ${code}`);
      
      return { success: true, tempToken };

    } catch (error) {
      console.error('Email send error:', error);
      throw new Error('Failed to send verification code');
    }
  }

  /**
   * Get user's 2FA status
   */
  async getStatus(userId: string): Promise<{
    enabled: boolean;
    methods: Array<{
      type: string;
      name: string;
      verified: boolean;
      enabled: boolean;
    }>;
    backupCodesRemaining: number;
  }> {
    const methods = await this.getTwoFactorMethods(userId);
    
    return {
      enabled: methods.some(m => m.enabled && m.verified),
      methods: methods.map(m => ({
        type: m.type,
        name: m.name,
        verified: m.verified,
        enabled: m.enabled
      })),
      backupCodesRemaining: methods
        .flatMap(m => m.backupCodes || [])
        .filter(bc => !bc.used).length
    };
  }
}

// Factory function to create 2FA instance
export function createTwoFactorAuth(redis: Redis, prisma: PrismaClient): TwoFactorAuthentication {
  return new TwoFactorAuthentication({
    redis,
    prisma,
    issuer: process.env.TWO_FACTOR_ISSUER || 'Vow',
    window: parseInt(process.env.TWO_FACTOR_WINDOW || '2'), // 2 time steps
    backupCodes: parseInt(process.env.TWO_FACTOR_BACKUP_CODES || '8'),
    rateLimit: {
      attempts: parseInt(process.env.TWO_FACTOR_RATE_LIMIT || '5'),
      window: process.env.TWO_FACTOR_RATE_LIMIT_WINDOW || '15m'
    },
    methods: ['totp', 'sms', 'email']
  });
}

// Export types
export type {
  TwoFactorConfig,
  TwoFactorBackup,
  TwoFactorMethod,
  TwoFactorSetup
};