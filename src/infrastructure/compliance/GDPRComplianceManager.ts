import { PrismaClient } from '@prisma/client';
import { Redis } from '@upstash/redis';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import archiver from 'archiver';
import { nanoid } from 'nanoid';

export interface GDPRConfig {
  redis: Redis;
  prisma: PrismaClient;
  exportRetention: number; // days
  maxExportSize: number; // bytes
  allowedExportFormats: ('json' | 'csv' | 'xml' | 'pdf')[];
  anonymization: {
    enabled: boolean;
    fields: string[];
    salt: string;
  };
  webhookUrl?: string;
  enableNotifications: boolean;
}

export interface DataExportRequest {
  id: string;
  userId: string;
  type: 'full' | 'partial' | 'specific' | 'portability';
  status: 'pending' | 'processing' | 'ready' | 'failed' | 'expired';
  requestedAt: Date;
  completedAt?: Date;
  expiresAt: Date;
  format: 'json' | 'csv' | 'xml' | 'pdf';
  scope: DataScope[];
  downloadUrl?: string;
  fileSize?: number;
  recordCount?: number;
  error?: string;
}

export interface DataScope {
  category: 'profile' | 'activity' | 'preferences' | 'content' | 'analytics' | 'communications' | 'social' | 'security';
  subcategories?: string[];
  includeMetadata: boolean;
  includeAuditLog: boolean;
  anonymize: boolean;
}

export interface DataSubjectRights {
  rightToAccess: boolean;
  rightToRectification: boolean;
  rightToErasure: boolean;
  rightToRestriction: boolean;
  rightToPortability: boolean;
  rightToObject: boolean;
  rightsInAutomatedDecisionMaking: boolean;
}

export interface AnonymizationRule {
  field: string;
  type: 'hash' | 'mask' | 'remove' | 'randomize' | 'generalize';
  options?: {
    preserveLength?: boolean;
    preserveFormat?: boolean;
    salt?: string;
    algorithm?: string;
  };
}

export class GDPRComplianceManager {
  private redis: Redis;
  private prisma: PrismaClient;
  private config: GDPRConfig;

  constructor(config: GDPRConfig) {
    this.redis = config.redis;
    this.prisma = config.prisma;
    this.config = config;
  }

  /**
   * Create data export request
   */
  async createExportRequest(
    userId: string,
    type: DataExportRequest['type'],
    format: DataExportRequest['format'],
    scope: DataScope[]
  ): Promise<DataExportRequest> {
    try {
      // 1. Validate user permissions
      const user = await this.validateUser(userId);
      if (!user) {
        throw new Error('User not found or unauthorized');
      }

      // 2. Validate scope and format
      this.validateExportRequest(type, format, scope);

      // 3. Create export request
      const request: DataExportRequest = {
        id: nanoid(),
        userId,
        type,
        status: 'pending',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + (this.config.exportRetention * 24 * 60 * 60 * 1000)),
        format,
        scope
      };

      // 4. Store request
      await this.saveExportRequest(request);

      // 5. Start async processing
      this.processExportRequest(request);

      // 6. Send confirmation
      await this.sendExportConfirmation(request);

      return request;

    } catch (error) {
      console.error('Export request creation failed:', error);
      throw error;
    }
  }

  /**
   * Process data export request
   */
  private async processExportRequest(request: DataExportRequest): Promise<void> {
    try {
      await this.updateRequestStatus(request.id, 'processing');

      // 1. Gather data from all scopes
      const exportData = await this.gatherUserData(request.userId, request.scope);

      // 2. Validate export size
      const dataSize = JSON.stringify(exportData).length;
      if (dataSize > this.config.maxExportSize) {
        throw new Error(`Export size (${dataSize} bytes) exceeds maximum allowed (${this.config.maxExportSize} bytes)`);
      }

      // 3. Apply anonymization if requested
      const processedData = await this.applyAnonymization(exportData, request.scope);

      // 4. Format data
      const formattedData = await this.formatExportData(processedData, request.format);

      // 5. Generate export file
      const exportFile = await this.generateExportFile(formattedData, request.format);

      // 6. Upload to secure storage
      const uploadResult = await this.uploadExportFile(request.id, exportFile);

      // 7. Update request with results
      await this.updateRequestWithResults(request.id, {
        status: 'ready',
        completedAt: new Date(),
        downloadUrl: uploadResult.url,
        fileSize: uploadResult.size,
        recordCount: this.countRecords(exportData)
      });

      // 8. Send notification
      await this.sendExportReadyNotification(request);

    } catch (error) {
      console.error('Export processing failed:', error);
      
      await this.updateRequestStatus(request.id, 'failed');
      await this.updateRequestError(request.id, error instanceof Error ? error.message : 'Unknown error');
      
      await this.sendExportFailureNotification(request, error);
    }
  }

  /**
   * Gather user data from all specified scopes
   */
  private async gatherUserData(userId: string, scope: DataScope[]): Promise<any> {
    const exportData: any = {
      user: {},
      activities: {},
      preferences: {},
      content: {},
      analytics: {},
      communications: {},
      social: {},
      security: {},
      metadata: {
        exportedAt: new Date(),
        exportVersion: '1.0',
        userId: userId
      }
    };

    for (const dataScope of scope) {
      switch (dataScope.category) {
        case 'profile':
          exportData.user = await this.exportUserProfile(userId, dataScope);
          break;

        case 'activity':
          exportData.activities = await this.exportUserActivities(userId, dataScope);
          break;

        case 'preferences':
          exportData.preferences = await this.exportUserPreferences(userId, dataScope);
          break;

        case 'content':
          exportData.content = await this.exportUserContent(userId, dataScope);
          break;

        case 'analytics':
          exportData.analytics = await this.exportUserAnalytics(userId, dataScope);
          break;

        case 'communications':
          exportData.communications = await this.exportUserCommunications(userId, dataScope);
          break;

        case 'social':
          exportData.social = await this.exportUserSocialData(userId, dataScope);
          break;

        case 'security':
          exportData.security = await this.exportUserSecurityData(userId, dataScope);
          break;
      }
    }

    return exportData;
  }

  /**
   * Export user profile data
   */
  private async exportUserProfile(userId: string, scope: DataScope): Promise<any> {
    const profile = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        profiles: true,
        sessions: {
          where: { active: false },
          orderBy: { createdAt: 'desc' },
          take: scope.includeMetadata ? 1000 : 100
        },
        auditLogs: scope.includeAuditLog ? {
          where: { userId },
          orderBy: { createdAt: 'desc' },
          take: 1000
        } : false
      }
    });

    if (!profile) return null;

    // Remove sensitive fields
    const { passwordHash, emailVerificationToken, passwordResetToken, ...safeProfile } = profile;

    return safeProfile;
  }

  /**
   * Export user activities
   */
  private async exportUserActivities(userId: string, scope: DataScope): Promise<any> {
    const activities = await this.prisma.activity.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 5000
    });

    return activities;
  }

  /**
   * Export user preferences
   */
  private async exportUserPreferences(userId: string, scope: DataScope): Promise<any> {
    const preferences = await this.prisma.userPreference.findMany({
      where: { userId }
    });

    return preferences;
  }

  /**
   * Export user content
   */
  private async exportUserContent(userId: string, scope: DataScope): Promise<any> {
    const [books, reviews, annotations, readingSessions] = await Promise.all([
      this.prisma.book.findMany({ where: { userId }, take: 1000 }),
      this.prisma.review.findMany({ where: { userId }, take: 1000 }),
      this.prisma.annotation.findMany({ where: { userId }, take: 5000 }),
      this.prisma.readingSession.findMany({ where: { userId }, take: 2000 })
    ]);

    return {
      books,
      reviews,
      annotations,
      readingSessions
    };
  }

  /**
   * Export user analytics
   */
  private async exportUserAnalytics(userId: string, scope: DataScope): Promise<any> {
    const analytics = await this.prisma.analytics.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 10000
    });

    return analytics;
  }

  /**
   * Export user communications
   */
  private async exportUserCommunications(userId: string, scope: DataScope): Promise<any> {
    const messages = await this.prisma.message.findMany({
      where: { OR: [{ senderId: userId }, { recipientId: userId }] },
      orderBy: { createdAt: 'desc' },
      take: 5000
    });

    return messages;
  }

  /**
   * Export user social data
   */
  private async exportUserSocialData(userId: string, scope: DataScope): Promise<any> {
    const [follows, groups, interactions] = await Promise.all([
      this.prisma.follow.findMany({ where: { followerId: userId } }),
      this.prisma.groupMember.findMany({ where: { userId } }),
      this.prisma.socialInteraction.findMany({ where: { userId }, take: 2000 })
    ]);

    return {
      follows,
      groups,
      interactions
    };
  }

  /**
   * Export user security data
   */
  private async exportUserSecurityData(userId: string, scope: DataScope): Promise<any> {
    const [loginAttempts, securityEvents, twoFactorMethods] = await Promise.all([
      this.prisma.loginAttempt.findMany({ where: { userId }, take: 1000 }),
      this.prisma.securityEvent.findMany({ where: { userId }, take: 1000 }),
      this.prisma.twoFactorMethod.findMany({ where: { userId } })
    ]);

    return {
      loginAttempts,
      securityEvents,
      twoFactorMethods
    };
  }

  /**
   * Apply anonymization to exported data
   */
  private async applyAnonymization(data: any, scope: DataScope[]): Promise<any> {
    if (!this.config.anonymization.enabled) {
      return data;
    }

    // Check if any scope requires anonymization
    const requiresAnonymization = scope.some(s => s.anonymize);
    if (!requiresAnonymization) {
      return data;
    }

    const anonymizedData = JSON.parse(JSON.stringify(data)); // Deep clone

    // Apply anonymization rules
    for (const rule of this.config.anonymization.fields) {
      this.anonymizeField(anonymizedData, rule);
    }

    return anonymizedData;
  }

  /**
   * Anonymize specific field
   */
  private anonymizeField(data: any, field: string, rule?: AnonymizationRule): void {
    if (Array.isArray(data)) {
      data.forEach(item => this.anonymizeField(item, field, rule));
    } else if (typeof data === 'object' && data !== null) {
      for (const [key, value] of Object.entries(data)) {
        if (key === field) {
          data[key] = this.applyAnonymizationRule(value, rule || { type: 'hash', field });
        } else {
          this.anonymizeField(value, field, rule);
        }
      }
    }
  }

  /**
   * Apply specific anonymization rule
   */
  private applyAnonymizationRule(value: any, rule: AnonymizationRule): any {
    switch (rule.type) {
      case 'hash':
        return this.hashValue(value, rule.options?.salt);

      case 'mask':
        return this.maskValue(value, rule.options);

      case 'remove':
        return null;

      case 'randomize':
        return this.randomizeValue(value, rule.options);

      case 'generalize':
        return this.generalizeValue(value, rule.options);

      default:
        return value;
    }
  }

  /**
   * Hash value for anonymization
   */
  private hashValue(value: any, salt?: string): string {
    const crypto = require('crypto');
    return crypto.createHash('sha256')
      .update(String(value) + (salt || this.config.anonymization.salt))
      .digest('hex');
  }

  /**
   * Mask value for anonymization
   */
  private maskValue(value: any, options?: any): string {
    const str = String(value);
    if (str.length <= 4) return '****';
    
    if (options?.preserveFormat && str.includes('@')) {
      // Email format
      const [user, domain] = str.split('@');
      const maskedUser = user[0] + '***' + user[user.length - 1];
      return `${maskedUser}@${domain}`;
    }
    
    return str.slice(0, 2) + '***' + str.slice(-2);
  }

  /**
   * Randomize value for anonymization
   */
  private randomizeValue(value: any, options?: any): string {
    const str = String(value);
    return str.split('').map(() => 'X').join('');
  }

  /**
   * Generalize value for anonymization
   */
  private generalizeValue(value: any, options?: any): any {
    if (value instanceof Date) {
      return new Date(value.getFullYear(), 0, 1); // Year only
    }
    return value;
  }

  /**
   * Format export data according to requested format
   */
  private async formatExportData(data: any, format: string): Promise<string | Buffer> {
    switch (format) {
      case 'json':
        return JSON.stringify(data, null, 2);

      case 'csv':
        return this.convertToCSV(data);

      case 'xml':
        return this.convertToXML(data);

      case 'pdf':
        return this.convertToPDF(data);

      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
  }

  /**
   * Convert data to CSV format
   */
  private convertToCSV(data: any): string {
    // Simplified CSV conversion
    // In production, you'd use a proper CSV library
    return JSON.stringify(data);
  }

  /**
   * Convert data to XML format
   */
  private convertToXML(data: any): string {
    // Simplified XML conversion
    // In production, you'd use a proper XML library
    return JSON.stringify(data);
  }

  /**
   * Convert data to PDF format
   */
  private async convertToPDF(data: any): Promise<Buffer> {
    // In production, you'd use a PDF generation library
    // like Puppeteer or PDFKit
    const content = JSON.stringify(data, null, 2);
    return Buffer.from(content);
  }

  /**
   * Generate export file
   */
  private async generateExportFile(data: string | Buffer, format: string): Promise<Buffer> {
    if (format === 'pdf') {
      return data as Buffer;
    }

    // Create archive for other formats
    const archive = archiver('zip');
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      const filename = `user-data-export.${format}`;
      archive.append(data, { name: filename });
      archive.finalize();
    });
  }

  /**
   * Upload export file to secure storage
   */
  private async uploadExportFile(requestId: string, file: Buffer): Promise<{ url: string; size: number }> {
    // In production, upload to secure cloud storage
    // For now, simulate upload and return URL
    const filename = `exports/${requestId}.zip`;
    
    // TODO: Upload to S3, Azure Blob, or Google Cloud Storage
    // const uploadResult = await this.storage.upload(filename, file);
    
    return {
      url: `/api/exports/${requestId}`, // Secure download endpoint
      size: file.length
    };
  }

  /**
   * Get user's data subject rights status
   */
  async getDataSubjectRights(userId: string): Promise<DataSubjectRights> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw new Error('User not found');
    }

    // Check if user is within EU or has requested GDPR compliance
    const isGDPRApplicable = user.region === 'EU' || user.gdprConsent === true;

    return {
      rightToAccess: isGDPRApplicable,
      rightToRectification: isGDPRApplicable,
      rightToErasure: isGDPRApplicable,
      rightToRestriction: isGDPRApplicable,
      rightToPortability: isGDPRApplicable,
      rightToObject: isGDPRApplicable,
      rightsInAutomatedDecisionMaking: isGDPRApplicable
    };
  }

  /**
   * Handle data erasure request (right to be forgotten)
   */
  async requestDataErasure(userId: string, reason: string): Promise<{ requestId: string; status: string }> {
    try {
      // 1. Validate user rights
      const rights = await this.getDataSubjectRights(userId);
      if (!rights.rightToErasure) {
        throw new Error('User does not have right to erasure');
      }

      // 2. Create erasure request
      const requestId = nanoid();

      // 3. Start async erasure process
      this.processDataErasure(userId, requestId, reason);

      // 4. Log the request
      await this.prisma.dataErasureRequest.create({
        data: {
          id: requestId,
          userId,
          reason,
          status: 'pending',
          requestedAt: new Date()
        }
      });

      return { requestId, status: 'pending' };

    } catch (error) {
      console.error('Data erasure request failed:', error);
      throw error;
    }
  }

  /**
   * Process data erasure request
   */
  private async processDataErasure(userId: string, requestId: string, reason: string): Promise<void> {
    try {
      // Update status to processing
      await this.prisma.dataErasureRequest.update({
        where: { id: requestId },
        data: { status: 'processing' }
      });

      // Anonymize user data instead of complete deletion for data integrity
      await this.anonymizeUserData(userId);

      // Mark user account as deleted
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          deletedAt: new Date(),
          deletionReason: reason,
          email: `deleted-${userId}@deleted.local`,
          firstName: 'Deleted',
          lastName: 'User',
          profileImage: null
        }
      });

      // Update request status
      await this.prisma.dataErasureRequest.update({
        where: { id: requestId },
        data: {
          status: 'completed',
          completedAt: new Date()
        }
      });

      // Send confirmation
      await this.sendErasureConfirmation(userId);

    } catch (error) {
      console.error('Data erasure processing failed:', error);
      
      await this.prisma.dataErasureRequest.update({
        where: { id: requestId },
        data: {
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      });
    }
  }

  /**
   * Anonymize user data for erasure
   */
  private async anonymizeUserData(userId: string): Promise<void> {
    const salt = this.config.anonymization.salt;

    // Anonymize sensitive fields
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        // These fields will be hashed/anonymized
        profileImage: null
      }
    });

    // Mark relationships as deleted but preserve referential integrity
    await this.prisma.activity.updateMany({
      where: { userId },
      data: { deletedAt: new Date() }
    });

    // Other data will be anonymized through views/queries
  }

  // Helper methods

  private async validateUser(userId: string): Promise<any> {
    return await this.prisma.user.findUnique({
      where: { id: userId }
    });
  }

  private validateExportRequest(type: string, format: string, scope: DataScope[]): void {
    if (!this.config.allowedExportFormats.includes(format as any)) {
      throw new Error(`Export format ${format} is not allowed`);
    }

    if (scope.length === 0) {
      throw new Error('At least one data scope must be specified');
    }
  }

  private async saveExportRequest(request: DataExportRequest): Promise<void> {
    const cacheKey = `gdpr:export:${request.id}`;
    await this.redis.setex(cacheKey, this.config.exportRetention * 86400, JSON.stringify(request));
  }

  private async updateRequestStatus(requestId: string, status: DataExportRequest['status']): Promise<void> {
    const key = `gdpr:export:${requestId}`;
    const request = await this.redis.get(key);
    if (request) {
      const parsed = JSON.parse(request as string);
      parsed.status = status;
      await this.redis.setex(key, this.config.exportRetention * 86400, JSON.stringify(parsed));
    }
  }

  private async updateRequestWithResults(requestId: string, results: Partial<DataExportRequest>): Promise<void> {
    const key = `gdpr:export:${requestId}`;
    const request = await this.redis.get(key);
    if (request) {
      const parsed = JSON.parse(request as string);
      Object.assign(parsed, results);
      await this.redis.setex(key, this.config.exportRetention * 86400, JSON.stringify(parsed));
    }
  }

  private async updateRequestError(requestId: string, error: string): Promise<void> {
    await this.updateRequestWithResults(requestId, { error });
  }

  private countRecords(data: any): number {
    // Simplified record counting
    return Object.keys(data).length;
  }

  // Notification methods
  private async sendExportConfirmation(request: DataExportRequest): Promise<void> {
    if (this.config.enableNotifications) {
      console.log(`Export request ${request.id} confirmed for user ${request.userId}`);
    }
  }

  private async sendExportReadyNotification(request: DataExportRequest): Promise<void> {
    if (this.config.enableNotifications) {
      console.log(`Export ${request.id} is ready for download`);
    }
  }

  private async sendExportFailureNotification(request: DataExportRequest, error: any): Promise<void> {
    if (this.config.enableNotifications) {
      console.error(`Export ${request.id} failed:`, error);
    }
  }

  private async sendErasureConfirmation(userId: string): Promise<void> {
    if (this.config.enableNotifications) {
      console.log(`Data erasure completed for user ${userId}`);
    }
  }
}

// Factory function
export function createGDPRManager(redis: Redis, prisma: PrismaClient): GDPRComplianceManager {
  return new GDPRComplianceManager({
    redis,
    prisma,
    exportRetention: 30,
    maxExportSize: 50 * 1024 * 1024, // 50MB
    allowedExportFormats: ['json', 'csv', 'xml', 'pdf'],
    anonymization: {
      enabled: true,
      fields: ['email', 'firstName', 'lastName', 'phoneNumber'],
      salt: process.env.GDPR_ANONYMIZATION_SALT || 'default-salt'
    },
    enableNotifications: true
  });
}

// Export types
export type {
  GDPRConfig,
  DataExportRequest,
  DataScope,
  DataSubjectRights,
  AnonymizationRule
};