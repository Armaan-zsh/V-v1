/**
 * Cost Optimization Dashboard
 * Enterprise-grade cost tracking, analysis, and optimization recommendations
 * Monitors infrastructure costs, API usage, and provides actionable insights
 */

import { z } from 'zod';
import Redis from 'ioredis';
import { PrismaClient } from '@prisma/client';
import { logger } from '../../shared/utils/logger';
import { circuitBreaker, CircuitBreakerOptions } from '../../shared/utils/circuitBreaker';

// Validation schemas
const CostMetricSchema = z.object({
  id: z.string(),
  category: z.enum(['infrastructure', 'api', 'storage', 'compute', 'network', 'third_party']),
  service: z.string(),
  resource: z.string(),
  timestamp: z.date(),
  cost: z.number(),
  currency: z.string().default('USD'),
  unit: z.string(),
  quantity: z.number(),
  metadata: z.record(z.any()),
  tags: z.array(z.string()),
});

const BudgetSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.enum(['infrastructure', 'api', 'storage', 'compute', 'network', 'third_party', 'total']),
  amount: z.number(),
  period: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']),
  alertThresholds: z.array(z.object({
    percentage: z.number(),
    enabled: z.boolean(),
    notified: z.boolean(),
  })),
  isActive: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
});

const OptimizationOpportunitySchema = z.object({
  id: z.string(),
  category: z.enum(['infrastructure', 'api', 'storage', 'compute', 'network', 'third_party']),
  service: z.string(),
  title: z.string(),
  description: z.string(),
  potentialSavings: z.number(),
  effort: z.enum(['low', 'medium', 'high']),
  confidence: z.number().min(0).max(1),
  impact: z.enum(['low', 'medium', 'high']),
  recommendations: z.array(z.object({
    action: z.string(),
    description: z.string(),
    expectedSavings: z.number(),
    implementationEffort: z.enum(['low', 'medium', 'high']),
    automated: z.boolean(),
  })),
  metadata: z.record(z.any()),
  createdAt: z.date(),
});

const CostReportSchema = z.object({
  id: z.string(),
  title: z.string(),
  period: z.object({
    start: z.date(),
    end: z.date(),
  }),
  totalCost: z.number(),
  currency: z.string(),
  breakdown: z.record(z.number()),
  trends: z.object({
    previousPeriod: z.number(),
    percentageChange: z.number(),
  }),
  topServices: z.array(z.object({
    service: z.string(),
    cost: z.number(),
    percentage: z.number(),
  })),
  recommendations: z.array(z.string()),
  alerts: z.array(z.object({
    type: z.enum(['budget', 'anomaly', 'recommendation']),
    severity: z.enum(['low', 'medium', 'high', 'critical']),
    message: z.string(),
    actionRequired: z.boolean(),
  })),
  generatedAt: z.date(),
});

// Types
export type CostMetric = z.infer<typeof CostMetricSchema>;
export type Budget = z.infer<typeof BudgetSchema>;
export type OptimizationOpportunity = z.infer<typeof OptimizationOpportunitySchema>;
export type CostReport = z.infer<typeof CostReportSchema>;

export interface CostDashboardConfig {
  refreshInterval: number; // milliseconds
  retentionPeriod: number; // days
  currency: string;
  budgetAlerts: {
    enabled: boolean;
    thresholds: number[]; // percentages
  };
  anomalyDetection: {
    enabled: boolean;
    sensitivity: number; // 0-1, higher = more sensitive
    lookbackDays: number;
  };
  optimization: {
    enabled: boolean;
    confidenceThreshold: number; // 0-1
    maxOpportunities: number;
  };
}

export interface CostMetrics {
  current: CostMetric[];
  historical: CostMetric[];
  aggregates: {
    byCategory: Record<string, number>;
    byService: Record<string, number>;
    byTime: Array<{ timestamp: Date; cost: number }>;
  };
  trends: {
    dailyGrowth: number;
    weeklyGrowth: number;
    monthlyGrowth: number;
    anomalies: Array<{ date: Date; expectedCost: number; actualCost: number }>;
  };
}

export interface CostAlert {
  id: string;
  type: 'budget_exceeded' | 'budget_warning' | 'cost_anomaly' | 'optimization_opportunity';
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  message: string;
  metadata: Record<string, any>;
  timestamp: Date;
  acknowledged: boolean;
  resolved: boolean;
}

// Error types
export class CostOptimizationError extends Error {
  constructor(
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = 'CostOptimizationError';
  }
}

export class BudgetExceededError extends CostOptimizationError {
  constructor(
    message: string,
    public budgetId: string,
    public actualCost: number,
    public budgetAmount: number
  ) {
    super(message, 'BUDGET_EXCEEDED');
  }
}

export class AnomalyDetectionError extends CostOptimizationError {
  constructor(message: string) {
    super(message, 'ANOMALY_DETECTION_FAILED');
  }
}

/**
 * Cost Optimization Dashboard Manager
 * Comprehensive cost tracking and optimization system
 */
export class CostOptimizationDashboard {
  private costMetrics: Map<string, CostMetric> = new Map();
  private budgets: Map<string, Budget> = new Map();
  private optimizationOpportunities: Map<string, OptimizationOpportunity> = new Map();
  private costAlerts: Map<string, CostAlert> = new Map();
  private redis: Redis;
  private prisma: PrismaClient;
  private config: CostDashboardConfig;
  private circuitBreakerOptions: CircuitBreakerOptions;
  private refreshInterval?: NodeJS.Timeout;

  constructor(
    redis: Redis,
    prisma: PrismaClient,
    config: Partial<CostDashboardConfig> = {}
  ) {
    this.redis = redis;
    this.prisma = prisma;
    this.config = {
      refreshInterval: 300000, // 5 minutes
      retentionPeriod: 90, // 90 days
      currency: 'USD',
      budgetAlerts: {
        enabled: true,
        thresholds: [50, 75, 90, 100], // percentages
      },
      anomalyDetection: {
        enabled: true,
        sensitivity: 0.3,
        lookbackDays: 30,
      },
      optimization: {
        enabled: true,
        confidenceThreshold: 0.7,
        maxOpportunities: 20,
      },
      ...config,
    };

    this.circuitBreakerOptions = {
      threshold: 0.1,
      timeout: 10000,
      resetTimeout: 60000,
      fallback: async () => null,
    };

    this.initializeDefaultBudgets();
    this.startMonitoring();
  }

  /**
   * Initialize default budgets
   */
  private async initializeDefaultBudgets(): Promise<void> {
    const defaultBudgets: Budget[] = [
      {
        id: 'total_monthly',
        name: 'Total Monthly Budget',
        category: 'total',
        amount: 5000,
        period: 'monthly',
        alertThresholds: [
          { percentage: 50, enabled: true, notified: false },
          { percentage: 75, enabled: true, notified: false },
          { percentage: 90, enabled: true, notified: false },
          { percentage: 100, enabled: true, notified: false },
        ],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'infrastructure_monthly',
        name: 'Infrastructure Monthly Budget',
        category: 'infrastructure',
        amount: 2000,
        period: 'monthly',
        alertThresholds: [
          { percentage: 60, enabled: true, notified: false },
          { percentage: 80, enabled: true, notified: false },
          { percentage: 100, enabled: true, notified: false },
        ],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      {
        id: 'api_monthly',
        name: 'API Usage Monthly Budget',
        category: 'api',
        amount: 1000,
        period: 'monthly',
        alertThresholds: [
          { percentage: 70, enabled: true, notified: false },
          { percentage: 90, enabled: true, notified: false },
          { percentage: 100, enabled: true, notified: false },
        ],
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];

    for (const budget of defaultBudgets) {
      await this.setBudget(budget);
    }
  }

  /**
   * Start monitoring and refresh cycle
   */
  private startMonitoring(): void {
    this.refreshInterval = setInterval(async () => {
      await this.performMonitoringCycle();
    }, this.config.refreshInterval);

    logger.info('Cost monitoring started', {
      refreshInterval: this.config.refreshInterval,
    });
  }

  /**
   * Perform monitoring cycle
   */
  private async performMonitoringCycle(): Promise<void> {
    try {
      // Refresh cost metrics
      await this.refreshCostMetrics();

      // Check budget alerts
      await this.checkBudgetAlerts();

      // Detect anomalies
      if (this.config.anomalyDetection.enabled) {
        await this.detectCostAnomalies();
      }

      // Generate optimization opportunities
      if (this.config.optimization.enabled) {
        await this.generateOptimizationOpportunities();
      }

      // Clean up old data
      await this.cleanupOldData();

    } catch (error) {
      logger.error('Cost monitoring cycle failed', { error });
    }
  }

  /**
   * Refresh cost metrics from various sources
   */
  private async refreshCostMetrics(): Promise<void> {
    try {
      const circuitBreakerFn = circuitBreaker(this.circuitBreakerOptions);
      
      // Refresh from multiple cost sources
      const refreshTasks = [
        this.refreshInfrastructureCosts(),
        this.refreshAPICosts(),
        this.refreshStorageCosts(),
        this.refreshComputeCosts(),
        this.refreshNetworkCosts(),
      ];

      await Promise.allSettled(refreshTasks);

    } catch (error) {
      logger.error('Failed to refresh cost metrics', { error });
      throw new CostOptimizationError(
        `Failed to refresh cost metrics: ${error.message}`,
        'REFRESH_FAILED'
      );
    }
  }

  /**
   * Refresh infrastructure costs
   */
  private async refreshInfrastructureCosts(): Promise<void> {
    // Mock infrastructure cost data (in production, integrate with cloud providers)
    const services = [
      { service: 'aws-ec2', resource: 'production-servers', unit: 'instance-hours' },
      { service: 'aws-rds', resource: 'postgresql-database', unit: 'db-hours' },
      { service: 'aws-elb', resource: 'load-balancers', unit: 'hours' },
      { service: 'aws-cloudfront', resource: 'cdn-requests', unit: 'requests' },
      { service: 'vercel', resource: 'deployment-bandwidth', unit: 'gb' },
    ];

    for (const svc of services) {
      const metric: CostMetric = {
        id: `infra_${svc.service}_${Date.now()}`,
        category: 'infrastructure',
        service: svc.service,
        resource: svc.resource,
        timestamp: new Date(),
        cost: Math.random() * 100 + 10,
        currency: this.config.currency,
        unit: svc.unit,
        quantity: Math.random() * 1000 + 100,
        metadata: {
          region: 'us-east-1',
          instanceType: 't3.medium',
          environment: 'production',
        },
        tags: ['infrastructure', 'production'],
      };

      await this.recordCostMetric(metric);
    }
  }

  /**
   * Refresh API costs
   */
  private async refreshAPICosts(): Promise<void> {
    // Mock API cost data
    const apis = [
      { service: 'openai', resource: 'gpt-4-requests', unit: 'requests' },
      { service: 'openai', resource: 'embedding-requests', unit: 'requests' },
      { service: 'anthropic', resource: 'claude-requests', unit: 'requests' },
      { service: 'stripe', resource: 'payment-processing', unit: 'transactions' },
      { service: 'sendgrid', resource: 'email-sending', unit: 'emails' },
    ];

    for (const api of apis) {
      const metric: CostMetric = {
        id: `api_${api.service}_${Date.now()}`,
        category: 'api',
        service: api.service,
        resource: api.resource,
        timestamp: new Date(),
        cost: Math.random() * 50 + 5,
        currency: this.config.currency,
        unit: api.unit,
        quantity: Math.random() * 10000 + 1000,
        metadata: {
          endpoint: `/api/${api.resource}`,
          region: 'global',
        },
        tags: ['api', 'third_party'],
      };

      await this.recordCostMetric(metric);
    }
  }

  /**
   * Refresh storage costs
   */
  private async refreshStorageCosts(): Promise<void> {
    // Mock storage cost data
    const storage = [
      { service: 'aws-s3', resource: 'user-uploads', unit: 'gb-month' },
      { service: 'aws-s3', resource: 'backups', unit: 'gb-month' },
      { service: 'aws-cloudfront', resource: 'static-assets', unit: 'requests' },
      { service: 'upstash', resource: 'redis-cache', unit: 'requests' },
    ];

    for (const stg of storage) {
      const metric: CostMetric = {
        id: `storage_${stg.service}_${Date.now()}`,
        category: 'storage',
        service: stg.service,
        resource: stg.resource,
        timestamp: new Date(),
        cost: Math.random() * 20 + 2,
        currency: this.config.currency,
        unit: stg.unit,
        quantity: Math.random() * 500 + 50,
        metadata: {
          storageClass: 'standard',
          region: 'us-east-1',
        },
        tags: ['storage', 'backup'],
      };

      await this.recordCostMetric(metric);
    }
  }

  /**
   * Refresh compute costs
   */
  private async refreshComputeCosts(): Promise<void> {
    // Mock compute cost data
    const compute = [
      { service: 'aws-lambda', resource: 'function-executions', unit: 'requests' },
      { service: 'vercel', resource: 'build-minutes', unit: 'minutes' },
      { service: 'inngest', resource: 'job-executions', unit: 'jobs' },
      { service: 'postgresql', resource: 'query-execution', unit: 'queries' },
    ];

    for (const comp of compute) {
      const metric: CostMetric = {
        id: `compute_${comp.service}_${Date.now()}`,
        category: 'compute',
        service: comp.service,
        resource: comp.resource,
        timestamp: new Date(),
        cost: Math.random() * 30 + 3,
        currency: this.config.currency,
        unit: comp.unit,
        quantity: Math.random() * 50000 + 5000,
        metadata: {
          region: 'us-east-1',
          environment: 'production',
        },
        tags: ['compute', 'serverless'],
      };

      await this.recordCostMetric(metric);
    }
  }

  /**
   * Refresh network costs
   */
  private async refreshNetworkCosts(): Promise<void> {
    // Mock network cost data
    const network = [
      { service: 'aws-dynamodb', resource: 'read-requests', unit: 'requests' },
      { service: 'aws-dynamodb', resource: 'write-requests', unit: 'requests' },
      { service: 'twilio', resource: 'sms-sending', unit: 'messages' },
      { service: 'twilio', resource: 'voice-calls', unit: 'minutes' },
    ];

    for (const net of network) {
      const metric: CostMetric = {
        id: `network_${net.service}_${Date.now()}`,
        category: 'network',
        service: net.service,
        resource: net.resource,
        timestamp: new Date(),
        cost: Math.random() * 15 + 1,
        currency: this.config.currency,
        unit: net.unit,
        quantity: Math.random() * 100000 + 10000,
        metadata: {
          region: 'global',
          dataTransfer: 'outbound',
        },
        tags: ['network', 'communication'],
      };

      await this.recordCostMetric(metric);
    }
  }

  /**
   * Record cost metric
   */
  async recordCostMetric(metric: CostMetric): Promise<void> {
    try {
      const validatedMetric = CostMetricSchema.parse(metric);
      
      this.costMetrics.set(validatedMetric.id, validatedMetric);

      // Store in Redis with TTL
      await this.redis.setex(
        `cost:metric:${validatedMetric.id}`,
        this.config.retentionPeriod * 24 * 60 * 60, // TTL in seconds
        JSON.stringify(validatedMetric)
      );

      // Also store in time-series format for analytics
      const timeSeriesKey = `cost:timeseries:${validatedMetric.category}:${validatedMetric.timestamp.getTime()}`;
      await this.redis.lpush(timeSeriesKey, validatedMetric.id);
      
      // Trim time series to keep only recent data
      await this.redis.ltrim(timeSeriesKey, 0, 10000); // Keep last 10k entries

      // Store time series key with TTL
      await this.redis.setex(`cost:timeseries:key:${validatedMetric.category}`, 86400, timeSeriesKey);

    } catch (error) {
      logger.error('Failed to record cost metric', { error, metric });
    }
  }

  /**
   * Set budget
   */
  async setBudget(budget: Budget): Promise<void> {
    try {
      const validatedBudget = BudgetSchema.parse(budget);
      
      this.budgets.set(validatedBudget.id, validatedBudget);

      // Store in Redis
      await this.redis.setex(
        `cost:budget:${validatedBudget.id}`,
        86400,
        JSON.stringify(validatedBudget)
      );

      logger.info('Budget set', {
        budgetId: validatedBudget.id,
        name: validatedBudget.name,
        amount: validatedBudget.amount,
        period: validatedBudget.period,
      });

    } catch (error) {
      logger.error('Failed to set budget', { error, budget });
      throw new CostOptimizationError(
        `Failed to set budget: ${error.message}`,
        'BUDGET_SET_FAILED'
      );
    }
  }

  /**
   * Check budget alerts
   */
  private async checkBudgetAlerts(): Promise<void> {
    if (!this.config.budgetAlerts.enabled) {
      return;
    }

    for (const [budgetId, budget] of this.budgets) {
      if (!budget.isActive) continue;

      try {
        const currentSpend = await this.calculateCurrentSpend(budget);
        const percentageUsed = (currentSpend / budget.amount) * 100;

        // Check against thresholds
        for (const threshold of budget.alertThresholds) {
          if (!threshold.enabled || threshold.notified) continue;

          if (percentageUsed >= threshold.percentage) {
            await this.triggerBudgetAlert(budget, currentSpend, threshold.percentage);
            threshold.notified = true;

            // Update budget in storage
            await this.setBudget(budget);
          }
        }

        // Check for budget exceeded
        if (percentageUsed >= 100 && !budget.alertThresholds.find(t => t.percentage === 100)?.notified) {
          await this.triggerBudgetExceededAlert(budget, currentSpend);
        }

      } catch (error) {
        logger.error('Failed to check budget alerts', { budgetId, error });
      }
    }
  }

  /**
   * Calculate current spend for budget
   */
  private async calculateCurrentSpend(budget: Budget): Promise<number> {
    try {
      const now = new Date();
      let startDate: Date;

      // Calculate start date based on budget period
      switch (budget.period) {
        case 'daily':
          startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          break;
        case 'weekly':
          const dayOfWeek = now.getDay();
          startDate = new Date(now.getTime() - dayOfWeek * 24 * 60 * 60 * 1000);
          break;
        case 'monthly':
          startDate = new Date(now.getFullYear(), now.getMonth(), 1);
          break;
        case 'quarterly':
          const quarter = Math.floor(now.getMonth() / 3);
          startDate = new Date(now.getFullYear(), quarter * 3, 1);
          break;
        case 'yearly':
          startDate = new Date(now.getFullYear(), 0, 1);
          break;
        default:
          startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }

      // Get metrics for the period
      const metrics = await this.getCostMetrics({
        startDate,
        endDate: now,
        category: budget.category === 'total' ? undefined : budget.category,
      });

      return metrics.aggregates.byCategory[budget.category] || 0;

    } catch (error) {
      logger.error('Failed to calculate current spend', { budgetId: budget.id, error });
      return 0;
    }
  }

  /**
   * Trigger budget alert
   */
  private async triggerBudgetAlert(
    budget: Budget,
    currentSpend: number,
    thresholdPercentage: number
  ): Promise<void> {
    const alert: CostAlert = {
      id: `budget_${budget.id}_${thresholdPercentage}_${Date.now()}`,
      type: 'budget_warning',
      severity: thresholdPercentage >= 90 ? 'critical' : thresholdPercentage >= 75 ? 'high' : 'medium',
      title: `Budget Alert: ${budget.name}`,
      message: `You have used ${thresholdPercentage}% of your ${budget.name} budget. Current spend: $${currentSpend.toFixed(2)} of $${budget.amount.toFixed(2)}`,
      metadata: {
        budgetId: budget.id,
        currentSpend,
        budgetAmount: budget.amount,
        thresholdPercentage,
      },
      timestamp: new Date(),
      acknowledged: false,
      resolved: false,
    };

    await this.addAlert(alert);
  }

  /**
   * Trigger budget exceeded alert
   */
  private async triggerBudgetExceededAlert(budget: Budget, currentSpend: number): Promise<void> {
    const alert: CostAlert = {
      id: `budget_exceeded_${budget.id}_${Date.now()}`,
      type: 'budget_exceeded',
      severity: 'critical',
      title: `Budget Exceeded: ${budget.name}`,
      message: `You have exceeded your ${budget.name} budget! Current spend: $${currentSpend.toFixed(2)} (Budget: $${budget.amount.toFixed(2)})`,
      metadata: {
        budgetId: budget.id,
        currentSpend,
        budgetAmount: budget.amount,
        overage: currentSpend - budget.amount,
      },
      timestamp: new Date(),
      acknowledged: false,
      resolved: false,
    };

    await this.addAlert(alert);

    // This is a critical alert that should be handled immediately
    await this.handleCriticalBudgetAlert(alert);
  }

  /**
   * Handle critical budget alert
   */
  private async handleCriticalBudgetAlert(alert: CostAlert): Promise<void> {
    try {
      // In production, this would:
      // 1. Send immediate notifications (email, Slack, SMS)
      // 2. Potentially implement cost controls
      // 3. Alert on-call personnel
      
      logger.critical('CRITICAL: Budget exceeded', {
        alertId: alert.id,
        metadata: alert.metadata,
      });

      // Mock automated response
      if (alert.metadata.budgetId === 'total_monthly') {
        // Could trigger cost-saving measures like:
        // - Reducing API rate limits
        // - Suspending non-critical services
        // - Switching to lower-cost regions
      }

    } catch (error) {
      logger.error('Failed to handle critical budget alert', { error, alert });
    }
  }

  /**
   * Add alert to system
   */
  private async addAlert(alert: CostAlert): Promise<void> {
    this.costAlerts.set(alert.id, alert);

    // Store in Redis
    await this.redis.setex(
      `cost:alert:${alert.id}`,
      86400 * 7, // 7 days
      JSON.stringify(alert)
    );

    logger.info('Cost alert added', {
      alertId: alert.id,
      type: alert.type,
      severity: alert.severity,
      budgetId: alert.metadata.budgetId,
    });
  }

  /**
   * Detect cost anomalies
   */
  private async detectCostAnomalies(): Promise<void> {
    try {
      const lookbackDays = this.config.anomalyDetection.lookbackDays;
      const startDate = new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000);
      const endDate = new Date();

      // Get historical data for anomaly detection
      const historicalMetrics = await this.getCostMetrics({
        startDate,
        endDate,
        interval: 'daily',
      });

      // Detect anomalies in total costs
      const totalCosts = historicalMetrics.aggregates.byTime.map(item => ({
        date: item.timestamp,
        cost: item.cost,
      }));

      const anomalies = this.identifyCostAnomalies(totalCosts);

      for (const anomaly of anomalies) {
        const alert: CostAlert = {
          id: `anomaly_${anomaly.date.getTime()}_${Date.now()}`,
          type: 'cost_anomaly',
          severity: Math.abs(anomaly.deviation) > 0.5 ? 'high' : 'medium',
          title: 'Cost Anomaly Detected',
          message: `Unusual cost pattern detected on ${anomaly.date.toDateString()}: $${anomaly.actualCost.toFixed(2)} (Expected: $${anomaly.expectedCost.toFixed(2)}, Deviation: ${(anomaly.deviation * 100).toFixed(1)}%)`,
          metadata: {
            date: anomaly.date,
            expectedCost: anomaly.expectedCost,
            actualCost: anomaly.actualCost,
            deviation: anomaly.deviation,
          },
          timestamp: new Date(),
          acknowledged: false,
          resolved: false,
        };

        await this.addAlert(alert);
      }

    } catch (error) {
      logger.error('Anomaly detection failed', { error });
      throw new AnomalyDetectionError(`Failed to detect anomalies: ${error.message}`);
    }
  }

  /**
   * Identify cost anomalies using statistical methods
   */
  private identifyCostAnomalies(
    data: Array<{ date: Date; cost: number }>
  ): Array<{ date: Date; expectedCost: number; actualCost: number; deviation: number }> {
    const anomalies: Array<{ date: Date; expectedCost: number; actualCost: number; deviation: number }> = [];

    if (data.length < 7) {
      return anomalies; // Need at least a week of data
    }

    // Calculate moving average and standard deviation
    const windowSize = 7;
    const mean = data.reduce((sum, item) => sum + item.cost, 0) / data.length;
    const variance = data.reduce((sum, item) => sum + Math.pow(item.cost - mean, 2), 0) / data.length;
    const stdDev = Math.sqrt(variance);

    // Check for anomalies
    for (let i = windowSize; i < data.length; i++) {
      const current = data[i];
      const recentData = data.slice(i - windowSize, i);
      const recentMean = recentData.reduce((sum, item) => sum + item.cost, 0) / windowSize;
      const recentStdDev = Math.sqrt(
        recentData.reduce((sum, item) => sum + Math.pow(item.cost - recentMean, 2), 0) / windowSize
      );

      const deviation = Math.abs(current.cost - recentMean) / recentStdDev;

      // Check if deviation exceeds sensitivity threshold
      if (deviation > this.config.anomalyDetection.sensitivity * 3) {
        anomalies.push({
          date: current.date,
          expectedCost: recentMean,
          actualCost: current.cost,
          deviation,
        });
      }
    }

    return anomalies;
  }

  /**
   * Generate optimization opportunities
   */
  private async generateOptimizationOpportunities(): Promise<void> {
    try {
      const opportunities: OptimizationOpportunity[] = [];

      // Analyze current spending patterns
      const recentMetrics = await this.getCostMetrics({
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
        endDate: new Date(),
      });

      // Generate opportunities based on spending analysis
      opportunities.push(...await this.identifyOverprovisioningOpportunities(recentMetrics));
      opportunities.push(...await this.identifyUnusedResourceOpportunities(recentMetrics));
      opportunities.push(...await this.identifyScalingOpportunities(recentMetrics));
      opportunities.push(...await this.identifyReservationOpportunities(recentMetrics));

      // Filter by confidence threshold
      const filteredOpportunities = opportunities.filter(
        opp => opp.confidence >= this.config.optimization.confidenceThreshold
      );

      // Sort by potential savings and take top N
      const topOpportunities = filteredOpportunities
        .sort((a, b) => b.potentialSavings - a.potentialSavings)
        .slice(0, this.config.optimization.maxOpportunities);

      // Store opportunities
      for (const opportunity of topOpportunities) {
        this.optimizationOpportunities.set(opportunity.id, opportunity);
        
        await this.redis.setex(
          `cost:optimization:${opportunity.id}`,
          86400 * 30, // 30 days
          JSON.stringify(opportunity)
        );

        // Generate alert for high-impact opportunities
        if (opportunity.impact === 'high' && opportunity.confidence > 0.8) {
          const alert: CostAlert = {
            id: `optimization_${opportunity.id}_${Date.now()}`,
            type: 'optimization_opportunity',
            severity: 'medium',
            title: 'Cost Optimization Opportunity',
            message: `${opportunity.title} - Potential savings: $${opportunity.potentialSavings.toFixed(2)}/month`,
            metadata: {
              opportunityId: opportunity.id,
              category: opportunity.category,
              potentialSavings: opportunity.potentialSavings,
              confidence: opportunity.confidence,
            },
            timestamp: new Date(),
            acknowledged: false,
            resolved: false,
          };

          await this.addAlert(alert);
        }
      }

      logger.info('Optimization opportunities generated', {
        total: opportunities.length,
        filtered: topOpportunities.length,
      });

    } catch (error) {
      logger.error('Failed to generate optimization opportunities', { error });
    }
  }

  /**
   * Identify overprovisioning opportunities
   */
  private async identifyOverprovisioningOpportunities(metrics: CostMetrics): Promise<OptimizationOpportunity[]> {
    const opportunities: OptimizationOpportunity[] = [];

    // Check infrastructure costs for overprovisioning
    const infrastructureCost = metrics.aggregates.byCategory.infrastructure || 0;
    if (infrastructureCost > 1000) { // Threshold for analysis
      opportunities.push({
        id: `opt_overprovisioning_${Date.now()}`,
        category: 'infrastructure',
        service: 'aws-ec2',
        title: 'EC2 Instance Right-Sizing',
        description: 'Analysis shows potential overprovisioning in compute resources. Consider downgrading underutilized instances or implementing auto-scaling.',
        potentialSavings: infrastructureCost * 0.25, // 25% savings potential
        effort: 'medium',
        confidence: 0.8,
        impact: 'high',
        recommendations: [
          {
            action: 'Enable CloudWatch detailed monitoring',
            description: 'Get better visibility into instance utilization',
            expectedSavings: infrastructureCost * 0.1,
            implementationEffort: 'low',
            automated: true,
          },
          {
            action: 'Implement auto-scaling',
            description: 'Scale instances based on demand',
            expectedSavings: infrastructureCost * 0.15,
            implementationEffort: 'high',
            automated: true,
          },
        ],
        metadata: {
          currentSpending: infrastructureCost,
          analysisPeriod: '30 days',
        },
        createdAt: new Date(),
      });
    }

    return opportunities;
  }

  /**
   * Identify unused resource opportunities
   */
  private async identifyUnusedResourceOpportunities(metrics: CostMetrics): Promise<OptimizationOpportunity[]> {
    const opportunities: OptimizationOpportunity[] = [];

    // Check for unused resources
    opportunities.push({
      id: `opt_unused_${Date.now()}`,
      category: 'storage',
      service: 'aws-s3',
      title: 'Unused S3 Buckets and Objects',
      description: 'Multiple S3 resources show minimal activity. Consider archival or deletion of unused data.',
      potentialSavings: 150,
      effort: 'low',
      confidence: 0.9,
      impact: 'medium',
      recommendations: [
        {
          action: 'Identify and remove unused objects',
          description: 'Clean up S3 buckets with low access patterns',
          expectedSavings: 100,
          implementationEffort: 'low',
          automated: true,
        },
        {
          action: 'Implement S3 lifecycle policies',
          description: 'Automatically transition old data to cheaper storage classes',
          expectedSavings: 50,
          implementationEffort: 'medium',
          automated: true,
        },
      ],
      metadata: {
        analysisMethod: 'usage_pattern_analysis',
        confidence: 0.9,
      },
      createdAt: new Date(),
    });

    return opportunities;
  }

  /**
   * Identify scaling opportunities
   */
  private async identifyScalingOpportunities(metrics: CostMetrics): Promise<OptimizationOpportunity[]> {
    const opportunities: OptimizationOpportunity[] = [];

    // Check API costs for scaling optimization
    const apiCost = metrics.aggregates.byCategory.api || 0;
    if (apiCost > 500) {
      opportunities.push({
        id: `opt_scaling_${Date.now()}`,
        category: 'api',
        service: 'openai',
        title: 'API Request Optimization',
        description: 'High API costs detected. Consider implementing request batching, caching, and request size optimization.',
        potentialSavings: apiCost * 0.3,
        effort: 'medium',
        confidence: 0.7,
        impact: 'high',
        recommendations: [
          {
            action: 'Implement request caching',
            description: 'Cache similar API requests to reduce duplicate calls',
            expectedSavings: apiCost * 0.2,
            implementationEffort: 'medium',
            automated: true,
          },
          {
            action: 'Optimize batch sizes',
            description: 'Combine multiple operations into single API calls',
            expectedSavings: apiCost * 0.1,
            implementationEffort: 'high',
            automated: false,
          },
        ],
        metadata: {
          currentAPICosts: apiCost,
          optimizationPotential: '30%',
        },
        createdAt: new Date(),
      });
    }

    return opportunities;
  }

  /**
   * Identify reservation opportunities
   */
  private async identifyReservationOpportunities(metrics: CostMetrics): Promise<OptimizationOpportunity[]> {
    const opportunities: OptimizationOpportunity[] = [];

    // Check for commitment savings opportunities
    const computeCost = metrics.aggregates.byCategory.compute || 0;
    if (computeCost > 800) {
      opportunities.push({
        id: `opt_reservation_${Date.now()}`,
        category: 'compute',
        service: 'aws-lambda',
        title: 'Reserved Capacity Planning',
        description: 'Steady compute usage patterns detected. Consider purchasing reserved capacity or savings plans for predictable workloads.',
        potentialSavings: computeCost * 0.4,
        effort: 'medium',
        confidence: 0.85,
        impact: 'high',
        recommendations: [
          {
            action: 'Purchase Reserved Instances',
            description: 'Commit to 1-year or 3-year reserved instances for predictable workloads',
            expectedSavings: computeCost * 0.4,
            implementationEffort: 'low',
            automated: false,
          },
          {
            action: 'Analyze usage patterns',
            description: 'Deep dive into compute usage to identify reservation opportunities',
            expectedSavings: 0,
            implementationEffort: 'medium',
            automated: false,
          },
        ],
        metadata: {
          currentComputeCosts: computeCost,
          commitmentLevel: 'on_demand',
        },
        createdAt: new Date(),
      });
    }

    return opportunities;
  }

  /**
   * Get cost metrics
   */
  async getCostMetrics(params: {
    startDate?: Date;
    endDate?: Date;
    category?: string;
    service?: string;
    interval?: 'hourly' | 'daily' | 'weekly' | 'monthly';
  } = {}): Promise<CostMetrics> {
    try {
      const {
        startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), // 30 days
        endDate = new Date(),
        category,
        service,
        interval = 'daily',
      } = params;

      // This would typically query from a time-series database
      // For now, we'll simulate the response structure

      const metrics: CostMetrics = {
        current: [],
        historical: [],
        aggregates: {
          byCategory: {},
          byService: {},
          byTime: [],
        },
        trends: {
          dailyGrowth: Math.random() * 0.2 - 0.1, // -10% to +10%
          weeklyGrowth: Math.random() * 0.3 - 0.15, // -15% to +15%
          monthlyGrowth: Math.random() * 0.4 - 0.2, // -20% to +20%
          anomalies: [],
        },
      };

      // Generate sample data
      const days = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
      
      for (let i = 0; i < days; i++) {
        const date = new Date(startDate.getTime() + i * 24 * 60 * 60 * 1000);
        const dailyCost = Math.random() * 200 + 50;
        
        metrics.aggregates.byTime.push({
          timestamp: date,
          cost: dailyCost,
        });

        // Add to category aggregates
        const categories = ['infrastructure', 'api', 'storage', 'compute', 'network'];
        for (const cat of categories) {
          const catCost = dailyCost * (Math.random() * 0.3 + 0.1); // 10-40% of daily cost
          metrics.aggregates.byCategory[cat] = (metrics.aggregates.byCategory[cat] || 0) + catCost;
        }
      }

      // Calculate service aggregates
      const services = ['aws-ec2', 'openai', 'aws-s3', 'aws-lambda', 'vercel'];
      for (const svc of services) {
        const svcCost = Math.random() * 300 + 50;
        metrics.aggregates.byService[svc] = svcCost;
      }

      return metrics;

    } catch (error) {
      logger.error('Failed to get cost metrics', { error, params });
      throw new CostOptimizationError(
        `Failed to get cost metrics: ${error.message}`,
        'METRICS_FAILED'
      );
    }
  }

  /**
   * Generate cost report
   */
  async generateCostReport(params: {
    title?: string;
    startDate: Date;
    endDate: Date;
    includeTrends?: boolean;
    includeRecommendations?: boolean;
  }): Promise<CostReport> {
    try {
      const {
        title = `Cost Report: ${params.startDate.toDateString()} - ${params.endDate.toDateString()}`,
        startDate,
        endDate,
        includeTrends = true,
        includeRecommendations = true,
      } = params;

      // Get metrics for the period
      const metrics = await this.getCostMetrics({
        startDate,
        endDate,
        interval: 'daily',
      });

      const totalCost = Object.values(metrics.aggregates.byCategory).reduce((sum, cost) => sum + cost, 0);

      // Generate top services
      const topServices = Object.entries(metrics.aggregates.byService)
        .map(([service, cost]) => ({
          service,
          cost,
          percentage: (cost / totalCost) * 100,
        }))
        .sort((a, b) => b.cost - a.cost)
        .slice(0, 5);

      // Calculate trends if requested
      let trends;
      if (includeTrends) {
        // Get previous period for comparison
        const prevStartDate = new Date(startDate.getTime() - (endDate.getTime() - startDate.getTime()));
        const prevMetrics = await this.getCostMetrics({
          startDate: prevStartDate,
          endDate: startDate,
          interval: 'daily',
        });

        const prevTotalCost = Object.values(prevMetrics.aggregates.byCategory).reduce((sum, cost) => sum + cost, 0);
        const percentageChange = totalCost > 0 ? ((totalCost - prevTotalCost) / prevTotalCost) * 100 : 0;

        trends = {
          previousPeriod: prevTotalCost,
          percentageChange,
        };
      }

      // Include recommendations if requested
      let recommendations: string[] = [];
      if (includeRecommendations) {
        recommendations = Array.from(this.optimizationOpportunities.values())
          .map(opp => `${opp.title} - Potential savings: $${opp.potentialSavings.toFixed(2)}/month`)
          .slice(0, 5);
      }

      // Get active alerts
      const activeAlerts = Array.from(this.costAlerts.values())
        .filter(alert => !alert.acknowledged && !alert.resolved)
        .map(alert => ({
          type: alert.type,
          severity: alert.severity,
          message: alert.message,
          actionRequired: alert.type === 'budget_exceeded' || alert.type === 'cost_anomaly',
        }));

      const report: CostReport = {
        id: `report_${Date.now()}`,
        title,
        period: {
          start: startDate,
          end: endDate,
        },
        totalCost,
        currency: this.config.currency,
        breakdown: metrics.aggregates.byCategory,
        trends: trends || {
          previousPeriod: 0,
          percentageChange: 0,
        },
        topServices,
        recommendations,
        alerts: activeAlerts,
        generatedAt: new Date(),
      };

      // Store report in Redis
      await this.redis.setex(
        `cost:report:${report.id}`,
        86400 * 30, // 30 days
        JSON.stringify(report)
      );

      logger.info('Cost report generated', {
        reportId: report.id,
        title: report.title,
        totalCost,
        period: `${startDate.toDateString()} - ${endDate.toDateString()}`,
      });

      return report;

    } catch (error) {
      logger.error('Failed to generate cost report', { error, params });
      throw new CostOptimizationError(
        `Failed to generate report: ${error.message}`,
        'REPORT_FAILED'
      );
    }
  }

  /**
   * Clean up old data
   */
  private async cleanupOldData(): Promise<void> {
    try {
      const cutoffDate = new Date(Date.now() - this.config.retentionPeriod * 24 * 60 * 60 * 1000);
      
      // Clean up old cost metrics
      const metricsToDelete: string[] = [];
      for (const [id, metric] of this.costMetrics) {
        if (metric.timestamp < cutoffDate) {
          metricsToDelete.push(id);
        }
      }

      for (const id of metricsToDelete) {
        this.costMetrics.delete(id);
        await this.redis.del(`cost:metric:${id}`);
      }

      // Clean up old alerts (keep resolved/acknowledged alerts for 30 days)
      const alertsToDelete: string[] = [];
      for (const [id, alert] of this.costAlerts) {
        if ((alert.resolved || alert.acknowledged) && alert.timestamp < cutoffDate) {
          alertsToDelete.push(id);
        }
      }

      for (const id of alertsToDelete) {
        this.costAlerts.delete(id);
        await this.redis.del(`cost:alert:${id}`);
      }

      logger.info('Old data cleanup completed', {
        deletedMetrics: metricsToDelete.length,
        deletedAlerts: alertsToDelete.length,
      });

    } catch (error) {
      logger.error('Failed to cleanup old data', { error });
    }
  }

  /**
   * Get current cost dashboard summary
   */
  async getDashboardSummary(): Promise<{
    totalMonthlySpend: number;
    budgetStatus: Array<{ budgetId: string; name: string; spent: number; limit: number; percentage: number }>;
    topCostCategories: Array<{ category: string; cost: number; percentage: number }>;
    activeAlerts: number;
    optimizationOpportunities: number;
    recentTrends: {
      daily: number;
      weekly: number;
      monthly: number;
    };
  }> {
    try {
      // Get current metrics
      const metrics = await this.getCostMetrics({
        startDate: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        endDate: new Date(),
      });

      // Calculate total monthly spend
      const totalMonthlySpend = Object.values(metrics.aggregates.byCategory).reduce((sum, cost) => sum + cost, 0);

      // Get budget status
      const budgetStatus = [];
      for (const [budgetId, budget] of this.budgets) {
        if (!budget.isActive) continue;

        const currentSpend = await this.calculateCurrentSpend(budget);
        budgetStatus.push({
          budgetId,
          name: budget.name,
          spent: currentSpend,
          limit: budget.amount,
          percentage: (currentSpend / budget.amount) * 100,
        });
      }

      // Get top cost categories
      const topCostCategories = Object.entries(metrics.aggregates.byCategory)
        .map(([category, cost]) => ({
          category,
          cost,
          percentage: (cost / totalMonthlySpend) * 100,
        }))
        .sort((a, b) => b.cost - a.cost);

      // Count active alerts
      const activeAlerts = Array.from(this.costAlerts.values()).filter(
        alert => !alert.acknowledged && !alert.resolved
      ).length;

      return {
        totalMonthlySpend,
        budgetStatus,
        topCostCategories,
        activeAlerts,
        optimizationOpportunities: this.optimizationOpportunities.size,
        recentTrends: metrics.trends,
      };

    } catch (error) {
      logger.error('Failed to get dashboard summary', { error });
      throw new CostOptimizationError(
        `Failed to get dashboard summary: ${error.message}`,
        'DASHBOARD_FAILED'
      );
    }
  }

  /**
   * Acknowledge alert
   */
  async acknowledgeAlert(alertId: string): Promise<void> {
    const alert = this.costAlerts.get(alertId);
    if (alert) {
      alert.acknowledged = true;
      this.costAlerts.set(alertId, alert);
      
      await this.redis.setex(
        `cost:alert:${alertId}`,
        86400 * 7,
        JSON.stringify(alert)
      );

      logger.info('Alert acknowledged', { alertId });
    }
  }

  /**
   * Resolve alert
   */
  async resolveAlert(alertId: string): Promise<void> {
    const alert = this.costAlerts.get(alertId);
    if (alert) {
      alert.resolved = true;
      this.costAlerts.set(alertId, alert);
      
      await this.redis.setex(
        `cost:alert:${alertId}`,
        86400 * 7,
        JSON.stringify(alert)
      );

      logger.info('Alert resolved', { alertId });
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
      logger.info('Cost monitoring stopped');
    }
  }

  /**
   * Get optimization opportunities
   */
  getOptimizationOpportunities(category?: string): OptimizationOpportunity[] {
    const opportunities = Array.from(this.optimizationOpportunities.values());
    return category ? opportunities.filter(opp => opp.category === category) : opportunities;
  }

  /**
   * Get active alerts
   */
  getActiveAlerts(): CostAlert[] {
    return Array.from(this.costAlerts.values()).filter(
      alert => !alert.acknowledged && !alert.resolved
    );
  }

  /**
   * Get budgets
   */
  getBudgets(): Budget[] {
    return Array.from(this.budgets.values());
  }

  /**
   * Cleanup resources
   */
  async cleanup(): Promise<void> {
    this.stopMonitoring();
    
    // Clear internal state
    this.costMetrics.clear();
    this.budgets.clear();
    this.optimizationOpportunities.clear();
    this.costAlerts.clear();
    
    logger.info('Cost optimization dashboard cleaned up');
  }
}

// Export singleton instance factory
export function createCostOptimizationDashboard(
  redis: Redis,
  prisma: PrismaClient,
  config?: Partial<CostDashboardConfig>
): CostOptimizationDashboard {
  return new CostOptimizationDashboard(redis, prisma, config);
}