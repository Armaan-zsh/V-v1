/**
 * API Versioning Strategy Implementation
 * Enterprise-grade versioning with backward compatibility, deprecation handling,
 * and automated migration assistance
 */

import { z } from 'zod';
import Redis from 'ioredis';
import { logger } from '../../shared/utils/logger';
import { circuitBreaker, CircuitBreakerOptions } from '../../shared/utils/circuitBreaker';

// Validation schemas
const APIVersionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'Version must follow semantic versioning'),
  releaseDate: z.date(),
  isActive: z.boolean(),
  isDeprecated: z.boolean(),
  deprecationDate: z.date().optional(),
  sunsetDate: z.date().optional(),
  supportLevel: z.enum(['GA', 'Beta', 'Alpha', 'Deprecated', 'EOL']),
  breakingChanges: z.array(z.object({
    endpoint: z.string(),
    description: z.string(),
    migrationGuide: z.string().optional(),
  })),
  backwardsCompatibility: z.object({
    clientVersions: z.array(z.string()),
    protocolVersions: z.array(z.string()),
    featureFlags: z.array(z.string()),
  }),
  metadata: z.object({
    documentationUrl: z.string().url().optional(),
    changelogUrl: z.string().url().optional(),
    supportContact: z.string().optional(),
    maxConcurrentRequests: z.number(),
    rateLimits: z.record(z.number()),
  }),
});

const VersionCompatibilitySchema = z.object({
  clientVersion: z.string(),
  apiVersion: z.string(),
  compatibilityLevel: z.enum(['full', 'partial', 'incompatible']),
  requiredFeatures: z.array(z.string()),
  deprecatedFeatures: z.array(z.string()),
  migrationPath: z.object({
    targetVersion: z.string(),
    steps: z.array(z.object({
      order: z.number(),
      action: z.string(),
      description: z.string(),
      automated: z.boolean(),
    })),
  }),
});

const EndpointSchema = z.object({
  path: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']),
  versions: z.array(z.string()),
  currentVersion: z.string(),
  deprecatedVersions: z.array(z.string()),
  removalDate: z.date().optional(),
  backwardCompatibilityMode: z.enum(['strict', 'graceful', 'none']),
  transformationRules: z.array(z.object({
    fromVersion: z.string(),
    toVersion: z.string(),
    transformations: z.array(z.object({
      field: z.string(),
      transformation: z.enum(['rename', 'type_change', 'move', 'remove', 'add']),
      oldField: z.string().optional(),
      newField: z.string().optional(),
      newType: z.string().optional(),
      defaultValue: z.any().optional(),
    })),
  })),
});

const MigrationRuleSchema = z.object({
  fromVersion: z.string(),
  toVersion: z.string(),
  rules: z.array(z.object({
    type: z.enum(['request', 'response', 'header', 'status']),
    field: z.string(),
    transformation: z.enum(['map', 'rename', 'remove', 'add', 'type_change']),
    mapping: z.record(z.string()).optional(),
    newName: z.string().optional(),
    newType: z.string().optional(),
    defaultValue: z.any().optional(),
    conditions: z.array(z.object({
      field: z.string(),
      operator: z.enum(['eq', 'ne', 'gt', 'lt', 'contains']),
      value: z.any(),
    })).optional(),
  })),
});

// Types
export type APIVersion = z.infer<typeof APIVersionSchema>;
export type VersionCompatibility = z.infer<typeof VersionCompatibilitySchema>;
export type Endpoint = z.infer<typeof EndpointSchema>;
export type MigrationRule = z.infer<typeof MigrationRuleSchema>;

export interface VersioningConfig {
  strategy: 'header' | 'url' | 'query_param' | 'media_type';
  defaultVersion: string;
  supportedVersions: string[];
  deprecationPolicy: {
    betaDuration: number; // days
    gaDuration: number; // days before deprecation
    deprecatedDuration: number; // days before removal
  };
  backwardCompatibility: {
    maxBackwardCompatibility: number; // major versions
    enableAutomaticMigration: boolean;
    migrationAssistance: boolean;
  };
  rateLimiting: {
    versionBasedLimits: boolean;
    baseLimits: Record<string, { requests: number; window: number }>;
  };
}

export interface RequestVersion {
  version?: string;
  clientId?: string;
  userAgent?: string;
  acceptHeader?: string;
  originalRequest: any;
}

export interface VersionedResponse {
  version: string;
  data: any;
  metadata: {
    version: string;
    deprecationWarning?: string;
    sunsetDate?: string;
    migrationUrl?: string;
    nextVersion?: string;
  };
}

export interface MigrationAssistance {
  currentVersion: string;
  targetVersion: string;
  breakingChanges: string[];
  migrationGuide: string;
  estimatedEffort: 'low' | 'medium' | 'high';
  automatedSteps: number;
  manualSteps: number;
  timeline: string;
}

// Error types
export class VersioningError extends Error {
  constructor(
    message: string,
    public version?: string,
    public code?: string
  ) {
    super(message);
    this.name = 'VersioningError';
  }
}

export class UnsupportedVersionError extends VersioningError {
  constructor(version: string, supportedVersions: string[]) {
    super(
      `API version '${version}' is not supported. Supported versions: ${supportedVersions.join(', ')}`,
      version,
      'UNSUPPORTED_VERSION'
    );
  }
}

export class VersionCompatibilityError extends VersioningError {
  constructor(message: string, version: string) {
    super(message, version, 'COMPATIBILITY_FAILED');
  }
}

/**
 * API Versioning Strategy Manager
 * Handles version negotiation, compatibility checking, and migration assistance
 */
export class APIVersioningManager {
  private versions: Map<string, APIVersion> = new Map();
  private endpoints: Map<string, Endpoint> = new Map();
  private compatibilityRules: Map<string, VersionCompatibility> = new Map();
  private migrationRules: Map<string, MigrationRule> = new Map();
  private redis: Redis;
  private config: VersioningConfig;
  private circuitBreakerOptions: CircuitBreakerOptions;

  constructor(
    redis: Redis,
    config: Partial<VersioningConfig> = {}
  ) {
    this.redis = redis;
    this.config = {
      strategy: 'header',
      defaultVersion: '1.0.0',
      supportedVersions: ['1.0.0', '1.1.0', '2.0.0'],
      deprecationPolicy: {
        betaDuration: 90, // 3 months
        gaDuration: 365, // 1 year
        deprecatedDuration: 180, // 6 months
      },
      backwardCompatibility: {
        maxBackwardCompatibility: 2,
        enableAutomaticMigration: true,
        migrationAssistance: true,
      },
      rateLimiting: {
        versionBasedLimits: true,
        baseLimits: {
          '1.0.0': { requests: 1000, window: 3600 }, // 1 hour
          '1.1.0': { requests: 2000, window: 3600 },
          '2.0.0': { requests: 5000, window: 3600 },
        },
      },
      ...config,
    };

    this.circuitBreakerOptions = {
      threshold: 0.1,
      timeout: 5000,
      resetTimeout: 30000,
      fallback: async () => this.config.defaultVersion,
    };

    this.initializeDefaultVersions();
  }

  /**
   * Initialize with default API versions
   */
  private async initializeDefaultVersions(): Promise<void> {
    const defaultVersions: APIVersion[] = [
      {
        version: '1.0.0',
        releaseDate: new Date('2024-01-01'),
        isActive: true,
        isDeprecated: false,
        supportLevel: 'GA',
        breakingChanges: [],
        backwardsCompatibility: {
          clientVersions: ['1.0.0'],
          protocolVersions: ['HTTP/1.1'],
          featureFlags: [],
        },
        metadata: {
          maxConcurrentRequests: 1000,
          rateLimits: {
            '/api/*': 1000,
          },
        },
      },
      {
        version: '1.1.0',
        releaseDate: new Date('2024-06-01'),
        isActive: true,
        isDeprecated: false,
        supportLevel: 'GA',
        breakingChanges: [],
        backwardsCompatibility: {
          clientVersions: ['1.0.0', '1.1.0'],
          protocolVersions: ['HTTP/1.1', 'HTTP/2'],
          featureFlags: ['enhanced_search', 'advanced_filtering'],
        },
        metadata: {
          maxConcurrentRequests: 2000,
          rateLimits: {
            '/api/*': 2000,
          },
        },
      },
      {
        version: '2.0.0',
        releaseDate: new Date('2024-11-01'),
        isActive: true,
        isDeprecated: false,
        supportLevel: 'Beta',
        breakingChanges: [
          {
            endpoint: '/api/auth/login',
            description: 'Authentication flow updated to use OAuth 2.0',
            migrationGuide: 'https://docs.vow.com/migration/auth-v2',
          },
        ],
        backwardsCompatibility: {
          clientVersions: ['2.0.0'],
          protocolVersions: ['HTTP/2', 'HTTP/3'],
          featureFlags: ['graphql', 'websocket_subscriptions'],
        },
        metadata: {
          maxConcurrentRequests: 5000,
          rateLimits: {
            '/api/*': 5000,
          },
        },
      },
    ];

    for (const version of defaultVersions) {
      await this.registerVersion(version);
    }
  }

  /**
   * Register new API version
   */
  async registerVersion(version: APIVersion): Promise<void> {
    try {
      const validatedVersion = APIVersionSchema.parse(version);
      
      this.versions.set(validatedVersion.version, validatedVersion);

      // Store in Redis for persistence
      await this.redis.setex(
        `api:version:${validatedVersion.version}`,
        86400,
        JSON.stringify(validatedVersion)
      );

      // Initialize compatibility rules
      await this.initializeCompatibilityRules(validatedVersion.version);

      // Setup migration rules
      await this.setupMigrationRules(validatedVersion.version);

      logger.info('API version registered', {
        version: validatedVersion.version,
        supportLevel: validatedVersion.supportLevel,
        isActive: validatedVersion.isActive,
      });

    } catch (error) {
      logger.error('Failed to register API version', { error, version });
      throw new VersioningError(
        `Failed to register version: ${error.message}`,
        version.version
      );
    }
  }

  /**
   * Register endpoint with versioning support
   */
  async registerEndpoint(endpoint: Endpoint): Promise<void> {
    try {
      const validatedEndpoint = EndpointSchema.parse(endpoint);
      
      const endpointKey = `${validatedEndpoint.method}:${validatedEndpoint.path}`;
      this.endpoints.set(endpointKey, validatedEndpoint);

      // Store in Redis
      await this.redis.setex(
        `api:endpoint:${endpointKey}`,
        86400,
        JSON.stringify(validatedEndpoint)
      );

      logger.info('API endpoint registered', {
        path: validatedEndpoint.path,
        method: validatedEndpoint.method,
        versions: validatedEndpoint.versions,
      });

    } catch (error) {
      logger.error('Failed to register endpoint', { error, endpoint });
      throw new VersioningError(
        `Failed to register endpoint: ${error.message}`
      );
    }
  }

  /**
   * Negotiate API version for incoming request
   */
  async negotiateVersion(request: RequestVersion): Promise<{
    version: string;
    compatibility: VersionCompatibility;
    requiresMigration: boolean;
    warnings: string[];
  }> {
    try {
      // Extract version from request
      const requestedVersion = this.extractVersionFromRequest(request);
      
      if (!requestedVersion) {
        // Return default version for requests without version info
        return {
          version: this.config.defaultVersion,
          compatibility: await this.getCompatibilityInfo(this.config.defaultVersion),
          requiresMigration: false,
          warnings: [],
        };
      }

      // Validate requested version
      if (!this.versions.has(requestedVersion)) {
        const supportedVersions = Array.from(this.versions.keys());
        throw new UnsupportedVersionError(requestedVersion, supportedVersions);
      }

      const version = this.versions.get(requestedVersion)!;

      // Check if version is deprecated
      const warnings = this.checkDeprecationStatus(version);

      // Get compatibility information
      const compatibility = await this.getCompatibilityInfo(requestedVersion);

      // Check if migration is recommended
      const requiresMigration = this.shouldRecommendMigration(version);

      return {
        version: requestedVersion,
        compatibility,
        requiresMigration,
        warnings,
      };

    } catch (error) {
      logger.error('Version negotiation failed', { error, request });
      throw new VersioningError(
        `Version negotiation failed: ${error.message}`,
        request.version
      );
    }
  }

  /**
   * Extract version from request headers/parameters
   */
  private extractVersionFromRequest(request: RequestVersion): string | null {
    const { version, clientId, userAgent, acceptHeader, originalRequest } = request;

    // 1. Check explicit version parameter
    if (version) {
      return version;
    }

    // 2. Check Accept header (media type versioning)
    if (this.config.strategy === 'media_type' && acceptHeader) {
      const versionMatch = acceptHeader.match(/application\/vnd\.vow\.v(\d+\.\d+\.\d+)\+json/);
      if (versionMatch) {
        return versionMatch[1];
      }
    }

    // 3. Check URL path versioning
    if (this.config.strategy === 'url' && originalRequest?.url) {
      const pathVersionMatch = originalRequest.url.match(/\/api\/v(\d+\.\d+\.\d+)\//);
      if (pathVersionMatch) {
        return pathVersionMatch[1];
      }
    }

    // 4. Check query parameter versioning
    if (this.config.strategy === 'query_param' && originalRequest?.url) {
      const url = new URL(originalRequest.url);
      const versionParam = url.searchParams.get('version');
      if (versionParam) {
        return versionParam;
      }
    }

    // 5. Check custom header
    if (this.config.strategy === 'header' && originalRequest?.headers) {
      const versionHeader = originalRequest.headers.get('X-API-Version');
      if (versionHeader) {
        return versionHeader;
      }
    }

    // 6. Infer from User-Agent (for older clients)
    if (userAgent) {
      const inferredVersion = this.inferVersionFromUserAgent(userAgent);
      if (inferredVersion) {
        return inferredVersion;
      }
    }

    // 7. Fallback to default version for legacy clients
    if (!clientId) {
      return this.config.defaultVersion;
    }

    return null;
  }

  /**
   * Infer version from User-Agent string
   */
  private inferVersionFromUserAgent(userAgent: string): string | null {
    // Common patterns for mobile apps and SDKs
    const patterns = [
      /Vow\/iOS\/(\d+\.\d+\.\d+)/,
      /Vow\/Android\/(\d+\.\d+\.\d+)/,
      /vow-sdk\/(\d+\.\d+\.\d+)/,
    ];

    for (const pattern of patterns) {
      const match = userAgent.match(pattern);
      if (match) {
        return match[1];
      }
    }

    return null;
  }

  /**
   * Check deprecation status and generate warnings
   */
  private checkDeprecationStatus(version: APIVersion): string[] {
    const warnings: string[] = [];

    if (version.isDeprecated) {
      warnings.push(`API version ${version.version} is deprecated`);

      if (version.sunsetDate) {
        const daysUntilSunset = Math.ceil(
          (version.sunsetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        );

        if (daysUntilSunset > 0) {
          warnings.push(
            `Version ${version.version} will be sunset in ${daysUntilSunset} days (${version.sunsetDate.toDateString()})`
          );
        } else {
          warnings.push(`Version ${version.version} has been sunset and may be unavailable`);
        }
      }
    }

    if (version.supportLevel === 'Beta' || version.supportLevel === 'Alpha') {
      warnings.push(`API version ${version.version} is in ${version.supportLevel} and may have stability issues`);
    }

    return warnings;
  }

  /**
   * Determine if migration should be recommended
   */
  private shouldRecommendMigration(version: APIVersion): boolean {
    // Recommend migration for:
    // 1. Deprecated versions
    // 2. Beta/Alpha versions
    // 3. Versions older than the default by more than 1 major version
    
    if (version.isDeprecated || version.supportLevel === 'Beta' || version.supportLevel === 'Alpha') {
      return true;
    }

    const [currentMajor] = this.config.defaultVersion.split('.').map(Number);
    const [versionMajor] = version.version.split('.').map(Number);

    return versionMajor < currentMajor - 1;
  }

  /**
   * Get compatibility information for version
   */
  private async getCompatibilityInfo(version: string): Promise<VersionCompatibility> {
    // Check if we have cached compatibility info
    const cacheKey = `api:compatibility:${version}`;
    const cached = await this.redis.get(cacheKey);

    if (cached) {
      return JSON.parse(cached);
    }

    // Generate compatibility info
    const currentVersion = this.versions.get(version);
    if (!currentVersion) {
      throw new VersioningError(`Version not found: ${version}`, version);
    }

    const compatibility: VersionCompatibility = {
      clientVersion: version,
      apiVersion: version,
      compatibilityLevel: 'full',
      requiredFeatures: currentVersion.backwardsCompatibility.featureFlags,
      deprecatedFeatures: [],
      migrationPath: {
        targetVersion: this.getRecommendedUpgrade(version),
        steps: await this.generateMigrationSteps(version, this.getRecommendedUpgrade(version)),
      },
    };

    // Cache for 1 hour
    await this.redis.setex(cacheKey, 3600, JSON.stringify(compatibility));

    return compatibility;
  }

  /**
   * Get recommended upgrade version
   */
  private getRecommendedUpgrade(currentVersion: string): string {
    const allVersions = Array.from(this.versions.values())
      .filter(v => v.isActive && !v.isDeprecated)
      .sort((a, b) => a.releaseDate.getTime() - b.releaseDate.getTime());

    const currentIndex = allVersions.findIndex(v => v.version === currentVersion);
    
    if (currentIndex === -1 || currentIndex === allVersions.length - 1) {
      return currentVersion; // Already on latest version
    }

    return allVersions[currentIndex + 1].version;
  }

  /**
   * Generate migration steps
   */
  private async generateMigrationSteps(
    fromVersion: string,
    toVersion: string
  ): Promise<VersionCompatibility['migrationPath']['steps']> {
    const steps: VersionCompatibility['migrationPath']['steps'] = [];

    // Check for migration rules
    const migrationRule = this.migrationRules.get(`${fromVersion}->${toVersion}`);
    
    if (migrationRule) {
      for (const rule of migrationRule.rules) {
        steps.push({
          order: steps.length + 1,
          action: `Apply ${rule.type} transformation for ${rule.field}`,
          description: `${rule.transformation} ${rule.type} field: ${rule.field}`,
          automated: this.canAutomateTransformation(rule),
        });
      }
    }

    // Add general upgrade steps
    if (fromVersion !== toVersion) {
      steps.push({
        order: steps.length + 1,
        action: 'Update client library/SDK',
        description: `Update to latest SDK supporting version ${toVersion}`,
        automated: false,
      });

      steps.push({
        order: steps.length + 1,
        action: 'Test API integration',
        description: 'Verify all endpoints work correctly with new version',
        automated: false,
      });
    }

    return steps;
  }

  /**
   * Check if transformation can be automated
   */
  private canAutomateTransformation(rule: MigrationRule['rules'][0]): boolean {
    // Simple transformations can be automated
    const automatable = ['rename', 'remove', 'add', 'type_change'];
    return automatable.includes(rule.transformation) && !rule.conditions?.length;
  }

  /**
   * Transform request to target version
   */
  async transformRequest(
    request: any,
    fromVersion: string,
    toVersion: string
  ): Promise<any> {
    try {
      const migrationRule = this.migrationRules.get(`${fromVersion}->${toVersion}`);
      
      if (!migrationRule) {
        logger.warn('No migration rule found', { fromVersion, toVersion });
        return request;
      }

      let transformedRequest = { ...request };

      for (const rule of migrationRule.rules) {
        if (rule.type === 'request') {
          transformedRequest = this.applyTransformation(transformedRequest, rule);
        }
      }

      logger.info('Request transformed', {
        fromVersion,
        toVersion,
        rulesApplied: migrationRule.rules.length,
      });

      return transformedRequest;

    } catch (error) {
      logger.error('Request transformation failed', {
        error,
        fromVersion,
        toVersion,
        request,
      });
      throw new VersionCompatibilityError(
        `Failed to transform request from ${fromVersion} to ${toVersion}: ${error.message}`,
        toVersion
      );
    }
  }

  /**
   * Transform response from source version to target version
   */
  async transformResponse(
    response: any,
    fromVersion: string,
    toVersion: string
  ): Promise<any> {
    try {
      const migrationRule = this.migrationRules.get(`${fromVersion}->${toVersion}`);
      
      if (!migrationRule) {
        return response;
      }

      let transformedResponse = { ...response };

      for (const rule of migrationRule.rules) {
        if (rule.type === 'response') {
          transformedResponse = this.applyTransformation(transformedResponse, rule);
        }
      }

      return transformedResponse;

    } catch (error) {
      logger.error('Response transformation failed', {
        error,
        fromVersion,
        toVersion,
        response,
      });
      throw new VersionCompatibilityError(
        `Failed to transform response from ${fromVersion} to ${toVersion}: ${error.message}`,
        fromVersion
      );
    }
  }

  /**
   * Apply transformation rule
   */
  private applyTransformation(data: any, rule: MigrationRule['rules'][0]): any {
    const transformed = { ...data };

    switch (rule.transformation) {
      case 'rename':
        if (rule.field in transformed && rule.newName) {
          transformed[rule.newName] = transformed[rule.field];
          delete transformed[rule.field];
        }
        break;

      case 'remove':
        delete transformed[rule.field];
        break;

      case 'add':
        if (!(rule.field in transformed) && rule.defaultValue !== undefined) {
          transformed[rule.field] = rule.defaultValue;
        }
        break;

      case 'type_change':
        if (rule.field in transformed && rule.newType) {
          transformed[rule.field] = this.castToType(transformed[rule.field], rule.newType);
        }
        break;

      case 'map':
        if (rule.field in transformed && rule.mapping) {
          const value = transformed[rule.field];
          transformed[rule.field] = rule.mapping[value] || value;
        }
        break;
    }

    return transformed;
  }

  /**
   * Cast value to target type
   */
  private castToType(value: any, targetType: string): any {
    switch (targetType) {
      case 'string':
        return String(value);
      case 'number':
        return Number(value);
      case 'boolean':
        return Boolean(value);
      case 'array':
        return Array.isArray(value) ? value : [value];
      case 'object':
        return typeof value === 'object' ? value : {};
      default:
        return value;
    }
  }

  /**
   * Generate versioned response
   */
  async generateVersionedResponse(
    data: any,
    version: string,
    metadata: Partial<VersionedResponse['metadata']> = {}
  ): Promise<VersionedResponse> {
    const apiVersion = this.versions.get(version);
    
    if (!apiVersion) {
      throw new VersioningError(`Unknown API version: ${version}`, version);
    }

    const response: VersionedResponse = {
      version,
      data,
      metadata: {
        version,
        ...metadata,
      },
    };

    // Add deprecation warnings
    if (apiVersion.isDeprecated && apiVersion.sunsetDate) {
      response.metadata.deprecationWarning = `API version ${version} is deprecated`;
      response.metadata.sunsetDate = apiVersion.sunsetDate.toISOString();
      
      // Add migration URL if available
      const migrationInfo = await this.getMigrationAssistance(version);
      if (migrationInfo) {
        response.metadata.migrationUrl = `/api/docs/migration/${version}`;
        response.metadata.nextVersion = migrationInfo.targetVersion;
      }
    }

    return response;
  }

  /**
   * Get migration assistance for version
   */
  async getMigrationAssistance(fromVersion: string): Promise<MigrationAssistance | null> {
    const targetVersion = this.getRecommendedUpgrade(fromVersion);
    
    if (targetVersion === fromVersion) {
      return null; // Already on latest version
    }

    const currentVersion = this.versions.get(fromVersion);
    const targetApiVersion = this.versions.get(targetVersion);
    
    if (!currentVersion || !targetApiVersion) {
      return null;
    }

    // Calculate migration complexity
    const migrationRule = this.migrationRules.get(`${fromVersion}->${targetVersion}`);
    const breakingChanges = currentVersion.breakingChanges;
    
    let effort: MigrationAssistance['estimatedEffort'] = 'low';
    let automatedSteps = 0;
    let manualSteps = 0;

    if (migrationRule) {
      automatedSteps = migrationRule.rules.filter(rule => this.canAutomateTransformation(rule)).length;
      manualSteps = migrationRule.rules.length - automatedSteps;
    }

    if (breakingChanges.length > 5 || manualSteps > 10) {
      effort = 'high';
    } else if (breakingChanges.length > 2 || manualSteps > 5) {
      effort = 'medium';
    }

    return {
      currentVersion: fromVersion,
      targetVersion,
      breakingChanges: breakingChanges.map(change => change.description),
      migrationGuide: `https://docs.vow.com/migration/${fromVersion}-to-${targetVersion}`,
      estimatedEffort: effort,
      automatedSteps,
      manualSteps,
      timeline: effort === 'high' ? '2-4 weeks' : effort === 'medium' ? '1-2 weeks' : '3-5 days',
    };
  }

  /**
   * Get version usage statistics
   */
  async getVersionStatistics(
    timeRange: { start: Date; end: Date } = {
      start: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days
      end: new Date(),
    }
  ): Promise<Record<string, {
    requests: number;
    uniqueClients: number;
    averageResponseTime: number;
    errorRate: number;
    deprecation: {
      isDeprecated: boolean;
      sunsetDate?: Date;
      daysUntilSunset?: number;
    };
  }>> {
    try {
      const stats: Record<string, any> = {};
      
      for (const [version, apiVersion] of this.versions) {
        const cacheKey = `api:stats:${version}:${timeRange.start.getTime()}:${timeRange.end.getTime()}`;
        const cached = await this.redis.get(cacheKey);
        
        if (cached) {
          stats[version] = JSON.parse(cached);
        } else {
          // Generate statistics (would typically come from analytics)
          const versionStats = {
            requests: Math.floor(Math.random() * 10000) + 1000,
            uniqueClients: Math.floor(Math.random() * 5000) + 500,
            averageResponseTime: Math.random() * 500 + 100,
            errorRate: Math.random() * 0.05,
            deprecation: {
              isDeprecated: apiVersion.isDeprecated,
              sunsetDate: apiVersion.sunsetDate,
              daysUntilSunset: apiVersion.sunsetDate ? 
                Math.ceil((apiVersion.sunsetDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)) : undefined,
            },
          };
          
          stats[version] = versionStats;
          
          // Cache for 1 hour
          await this.redis.setex(cacheKey, 3600, JSON.stringify(versionStats));
        }
      }

      return stats;
    } catch (error) {
      logger.error('Failed to get version statistics', { error });
      throw new VersioningError(`Failed to get statistics: ${error.message}`);
    }
  }

  /**
   * Check rate limits for version
   */
  async checkRateLimit(
    version: string,
    clientId: string,
    endpoint: string
  ): Promise<{
    allowed: boolean;
    remaining: number;
    resetTime: number;
    limit: number;
  }> {
    try {
      const apiVersion = this.versions.get(version);
      if (!apiVersion) {
        throw new VersioningError(`Unknown API version: ${version}`, version);
      }

      const limitConfig = this.config.rateLimiting.baseLimits[version];
      if (!limitConfig) {
        // Use default limits if version-specific not configured
        const defaultLimit = this.config.rateLimiting.baseLimits[this.config.defaultVersion];
        if (!defaultLimit) {
          return { allowed: true, remaining: 1000, resetTime: Date.now() + 3600000, limit: 1000 };
        }
      }

      const limit = limitConfig || this.config.rateLimiting.baseLimits[this.config.defaultVersion];
      const cacheKey = `api:ratelimit:${version}:${clientId}:${endpoint}`;
      
      const current = await this.redis.get(cacheKey);
      const now = Date.now();
      
      if (!current) {
        // First request
        await this.redis.setex(cacheKey, limit.window, '1');
        return {
          allowed: true,
          remaining: limit.requests - 1,
          resetTime: now + (limit.window * 1000),
          limit: limit.requests,
        };
      }

      const count = parseInt(current);
      const remaining = Math.max(0, limit.requests - count);

      return {
        allowed: remaining > 0,
        remaining,
        resetTime: now + (limit.window * 1000),
        limit: limit.requests,
      };

    } catch (error) {
      logger.error('Rate limit check failed', { error, version, clientId, endpoint });
      // Fail open for rate limiting
      return { allowed: true, remaining: 1000, resetTime: Date.now() + 3600000, limit: 1000 };
    }
  }

  /**
   * Initialize compatibility rules
   */
  private async initializeCompatibilityRules(version: string): Promise<void> {
    const compatibility: VersionCompatibility = {
      clientVersion: version,
      apiVersion: version,
      compatibilityLevel: 'full',
      requiredFeatures: [],
      deprecatedFeatures: [],
      migrationPath: {
        targetVersion: this.getRecommendedUpgrade(version),
        steps: [],
      },
    };

    this.compatibilityRules.set(version, compatibility);
    
    await this.redis.setex(
      `api:compatibility:${version}`,
      86400,
      JSON.stringify(compatibility)
    );
  }

  /**
   * Setup migration rules
   */
  private async setupMigrationRules(version: string): Promise<void> {
    // Create migration rules from older versions to this version
    for (const [existingVersion, existingApi] of this.versions) {
      if (existingVersion !== version) {
        const migrationRule = await this.generateMigrationRule(existingVersion, version);
        if (migrationRule) {
          this.migrationRules.set(`${existingVersion}->${version}`, migrationRule);
          
          await this.redis.setex(
            `api:migration:${existingVersion}->${version}`,
            86400,
            JSON.stringify(migrationRule)
          );
        }
      }
    }
  }

  /**
   * Generate migration rule between versions
   */
  private async generateMigrationRule(
    fromVersion: string,
    toVersion: string
  ): Promise<MigrationRule | null> {
    const fromApi = this.versions.get(fromVersion);
    const toApi = this.versions.get(toVersion);
    
    if (!fromApi || !toApi) {
      return null;
    }

    // Simplified migration rule generation
    // In production, this would analyze actual API differences
    
    const rules: MigrationRule['rules'] = [];

    // Add transformation rules based on breaking changes
    for (const breakingChange of fromApi.breakingChanges) {
      // This would contain actual transformation logic
      rules.push({
        type: 'response',
        field: 'auth_token',
        transformation: 'rename',
        newName: 'access_token',
      });
    }

    return {
      fromVersion,
      toVersion,
      rules,
    };
  }

  /**
   * Get all registered versions
   */
  getAllVersions(): APIVersion[] {
    return Array.from(this.versions.values());
  }

  /**
   * Get specific version info
   */
  getVersionInfo(version: string): APIVersion | null {
    return this.versions.get(version) || null;
  }

  /**
   * Get supported versions
   */
  getSupportedVersions(): string[] {
    return Array.from(this.versions.values())
      .filter(v => v.isActive && !v.isDeprecated)
      .map(v => v.version);
  }

  /**
   * Get deprecated versions
   */
  getDeprecatedVersions(): APIVersion[] {
    return Array.from(this.versions.values()).filter(v => v.isDeprecated);
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    // Clear internal state
    this.versions.clear();
    this.endpoints.clear();
    this.compatibilityRules.clear();
    this.migrationRules.clear();
    
    logger.info('API versioning manager cleaned up');
  }
}

// Export singleton instance factory
export function createAPIVersioningManager(
  redis: Redis,
  config?: Partial<VersioningConfig>
): APIVersioningManager {
  return new APIVersioningManager(redis, config);
}