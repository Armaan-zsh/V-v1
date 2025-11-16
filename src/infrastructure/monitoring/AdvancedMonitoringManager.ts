import { Redis } from '@upstash/redis';
import { PrismaClient } from '@prisma/client';

export interface MonitoringConfig {
  redis: Redis;
  prisma: PrismaClient;
  metricsRetention: number; // days
  alertThresholds: {
    errorRate: number;
    latencyP95: number;
    latencyP99: number;
    availability: number;
    errorBudget: number;
  };
  slos: SLOTarget[];
  enableRealTimeMonitoring: boolean;
  dashboardUrl?: string;
  alertWebhook?: string;
}

export interface Metric {
  name: string;
  value: number;
  timestamp: Date;
  labels: Record<string, string>;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  unit?: string;
  description?: string;
}

export interface SLOTarget {
  id: string;
  name: string;
  description: string;
  service: string;
  objective: number; // 0.999 for 99.9% availability
  errorBudget: number; // 0.001 for 99.9%
  window: string; // '30d', '7d', '24h'
  targets: SLOTargetMetric[];
  status: 'healthy' | 'degraded' | 'violated';
  lastUpdated: Date;
  compliancePercentage: number;
}

export interface SLOTargetMetric {
  name: string;
  metric: string;
  threshold: number;
  comparison: 'lt' | 'gt' | 'lte' | 'gte' | 'eq';
  weight: number;
}

export interface AlertRule {
  id: string;
  name: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  condition: AlertCondition;
  actions: AlertAction[];
  enabled: boolean;
  cooldown: number; // minutes
  lastTriggered?: Date;
  triggerCount: number;
}

export interface AlertCondition {
  metric: string;
  threshold: number;
  comparison: 'gt' | 'lt' | 'gte' | 'lte' | 'eq';
  aggregation: 'avg' | 'min' | 'max' | 'sum';
  window: string; // '5m', '15m', '1h'
  additionalFilters?: Record<string, string>;
}

export interface AlertAction {
  type: 'webhook' | 'email' | 'slack' | 'pagerduty' | 'sms';
  target: string;
  template: string;
}

export interface HealthCheck {
  id: string;
  name: string;
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  expectedStatus: number;
  timeout: number;
  interval: number;
  enabled: boolean;
  lastCheck: Date;
  status: 'healthy' | 'degraded' | 'down';
  responseTime: number;
  errorMessage?: string;
}

export class AdvancedMonitoringManager {
  private redis: Redis;
  private prisma: PrismaClient;
  private config: MonitoringConfig;
  private metricsBuffer: Metric[] = [];
  private healthChecks: Map<string, HealthCheck> = new Map();

  constructor(config: MonitoringConfig) {
    this.redis = config.redis;
    this.prisma = config.prisma;
    this.config = config;
    
    // Initialize monitoring
    this.initializeHealthChecks();
    this.startMetricsCollection();
  }

  /**
   * Record metric with automatic aggregation
   */
  async recordMetric(metric: Metric): Promise<void> {
    try {
      // 1. Store in Redis for real-time access
      await this.storeRealTimeMetric(metric);

      // 2. Add to buffer for batch processing
      this.metricsBuffer.push(metric);

      // 3. Process if buffer is full
      if (this.metricsBuffer.length >= 100) {
        await this.processMetricsBuffer();
      }

      // 4. Check alert rules
      await this.checkAlertRules(metric);

      // 5. Update SLO calculations
      await this.updateSLOCalculations(metric);

    } catch (error) {
      console.error('Failed to record metric:', error);
    }
  }

  /**
   * Get metrics with time range and filters
   */
  async getMetrics(
    metricName: string,
    startTime: Date,
    endTime: Date,
    filters?: Record<string, string>
  ): Promise<Metric[]> {
    try {
      const key = `metrics:${metricName}`;
      const patterns = await this.redis.zrangebyscore(
        key,
        startTime.getTime(),
        endTime.getTime()
      );

      const metrics: Metric[] = [];
      for (const pattern of patterns) {
        const metric = JSON.parse(pattern);
        
        // Apply filters if specified
        if (filters && !this.matchesFilters(metric.labels, filters)) {
          continue;
        }
        
        metrics.push(metric);
      }

      return metrics;

    } catch (error) {
      console.error('Failed to get metrics:', error);
      return [];
    }
  }

  /**
   * Calculate service level objectives compliance
   */
  async calculateSLOCompliance(sloId: string): Promise<number> {
    const slo = await this.getSLO(sloId);
    if (!slo) return 0;

    let compliantMeasurements = 0;
    let totalMeasurements = 0;

    for (const target of slo.targets) {
      const measurements = await this.getMetricMeasurements(
        target.metric,
        slo.window
      );

      for (const measurement of measurements) {
        totalMeasurements++;
        if (this.evaluateThreshold(measurement.value, target.threshold, target.comparison)) {
          compliantMeasurements++;
        }
      }
    }

    return totalMeasurements > 0 ? compliantMeasurements / totalMeasurements : 1;
  }

  /**
   * Get SLO dashboard data
   */
  async getSLODashboard(): Promise<{
    overall: SLOTarget[];
    byService: Record<string, SLOTarget[]>;
    recentViolations: SLOTarget[];
    errorBudget: Record<string, { used: number; remaining: number; burnRate: number }>;
  }> {
    const slos = await this.getAllSLOs();

    // Calculate compliance for each SLO
    const slosWithCompliance = await Promise.all(
      slos.map(async (slo) => {
        const compliance = await this.calculateSLOCompliance(slo.id);
        return {
          ...slo,
          compliancePercentage: compliance * 100,
          status: this.determineSLOStatus(compliance, slo.objective)
        };
      })
    );

    // Group by service
    const byService: Record<string, SLOTarget[]> = {};
    slosWithCompliance.forEach(slo => {
      if (!byService[slo.service]) {
        byService[slo.service] = [];
      }
      byService[slo.service].push(slo);
    });

    // Get recent violations
    const recentViolations = slosWithCompliance.filter(slo => slo.status === 'violated');

    // Calculate error budget usage
    const errorBudget: Record<string, { used: number; remaining: number; burnRate: number }> = {};
    slosWithCompliance.forEach(slo => {
      const used = 1 - (slo.compliancePercentage / 100);
      const remaining = slo.errorBudget - used;
      const burnRate = this.calculateBurnRate(slo.id, slo.window);
      
      errorBudget[slo.id] = {
        used: Math.max(0, used),
        remaining: Math.max(0, remaining),
        burnRate
      };
    });

    return {
      overall: slosWithCompliance,
      byService,
      recentViolations,
      errorBudget
    };
  }

  /**
   * Create alert rule
   */
  async createAlertRule(rule: Omit<AlertRule, 'id' | 'triggerCount'>): Promise<AlertRule> {
    const alertRule: AlertRule = {
      ...rule,
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      triggerCount: 0
    };

    // Store in database
    await this.prisma.alertRule.create({
      data: {
        id: alertRule.id,
        name: alertRule.name,
        description: alertRule.description,
        severity: alertRule.severity,
        condition: JSON.stringify(alertRule.condition),
        actions: JSON.stringify(alertRule.actions),
        enabled: alertRule.enabled,
        cooldown: alertRule.cooldown
      }
    });

    return alertRule;
  }

  /**
   * Check all alert rules against current metrics
   */
  private async checkAlertRules(metric: Metric): Promise<void> {
    try {
      const rules = await this.getActiveAlertRules();
      
      for (const rule of rules) {
        const shouldTrigger = await this.evaluateAlertRule(rule, metric);
        
        if (shouldTrigger) {
          await this.triggerAlert(rule, metric);
        }
      }
    } catch (error) {
      console.error('Alert rule check failed:', error);
    }
  }

  /**
   * Trigger alert
   */
  private async triggerAlert(rule: AlertRule, metric: Metric): Promise<void> {
    try {
      // Check cooldown period
      if (rule.lastTriggered && 
          Date.now() - rule.lastTriggered.getTime() < rule.cooldown * 60 * 1000) {
        return;
      }

      // Update rule trigger count and last triggered
      await this.prisma.alertRule.update({
        where: { id: rule.id },
        data: {
          lastTriggered: new Date(),
          triggerCount: rule.triggerCount + 1
        }
      });

      // Execute alert actions
      for (const action of rule.actions) {
        await this.executeAlertAction(action, rule, metric);
      }

      // Log alert event
      await this.logAlertEvent(rule, metric);

    } catch (error) {
      console.error('Alert trigger failed:', error);
    }
  }

  /**
   * Execute alert action
   */
  private async executeAlertAction(
    action: AlertAction,
    rule: AlertRule,
    metric: Metric
  ): Promise<void> {
    try {
      switch (action.type) {
        case 'webhook':
          await this.sendWebhookAlert(action.target, rule, metric);
          break;
          
        case 'email':
          await this.sendEmailAlert(action.target, rule, metric);
          break;
          
        case 'slack':
          await this.sendSlackAlert(action.target, rule, metric);
          break;
          
        case 'pagerduty':
          await this.sendPagerDutyAlert(action.target, rule, metric);
          break;
          
        case 'sms':
          await this.sendSMSAlert(action.target, rule, metric);
          break;
      }
    } catch (error) {
      console.error(`Alert action ${action.type} failed:`, error);
    }
  }

  /**
   * Perform health checks
   */
  async performHealthChecks(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];

    for (const check of this.healthChecks.values()) {
      if (!check.enabled) continue;

      try {
        const startTime = Date.now();
        
        // Perform the actual health check
        const isHealthy = await this.executeHealthCheck(check);
        const responseTime = Date.now() - startTime;

        check.lastCheck = new Date();
        check.responseTime = responseTime;
        check.status = isHealthy ? 'healthy' : 'degraded';
        check.errorMessage = undefined;

        results.push({ ...check });

        // Record health metric
        await this.recordMetric({
          name: 'health_check_status',
          value: isHealthy ? 1 : 0,
          timestamp: new Date(),
          labels: {
            check_id: check.id,
            check_name: check.name
          },
          type: 'gauge',
          description: 'Health check status (1=healthy, 0=unhealthy)'
        });

        await this.recordMetric({
          name: 'health_check_duration',
          value: responseTime,
          timestamp: new Date(),
          labels: {
            check_id: check.id,
            check_name: check.name
          },
          type: 'histogram',
          unit: 'ms',
          description: 'Health check response time'
        });

      } catch (error) {
        check.status = 'down';
        check.errorMessage = error instanceof Error ? error.message : 'Unknown error';
        results.push({ ...check });
      }
    }

    return results;
  }

  /**
   * Get monitoring dashboard data
   */
  async getDashboard(): Promise<{
    metrics: Record<string, Metric[]>;
    slos: SLOTarget[];
    alerts: AlertRule[];
    healthStatus: HealthCheck[];
    systemStatus: 'healthy' | 'degraded' | 'down';
  }> {
    // Get recent metrics
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - (15 * 60 * 1000)); // Last 15 minutes

    const metricNames = [
      'http_requests_total',
      'http_request_duration',
      'error_rate',
      'active_users',
      'response_time_p95'
    ];

    const metrics: Record<string, Metric[]> = {};
    for (const name of metricNames) {
      metrics[name] = await this.getMetrics(name, startTime, endTime);
    }

    // Get SLOs
    const slos = await this.getAllSLOs();

    // Get active alerts
    const alerts = await this.getActiveAlertRules();

    // Get health checks
    const healthChecks = Array.from(this.healthChecks.values());

    // Determine overall system status
    const systemStatus = this.calculateSystemStatus(healthChecks, slos);

    return {
      metrics,
      slos,
      alerts,
      healthStatus: healthChecks,
      systemStatus
    };
  }

  /**
   * Record business metrics
   */
  async recordBusinessMetric(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): Promise<void> {
    await this.recordMetric({
      name,
      value,
      timestamp: new Date(),
      labels: {
        ...labels,
        category: 'business'
      },
      type: 'gauge',
      description: `Business metric: ${name}`
    });
  }

  /**
   * Record technical metrics
   */
  async recordTechnicalMetric(
    name: string,
    value: number,
    labels?: Record<string, string>
  ): Promise<void> {
    await this.recordMetric({
      name,
      value,
      timestamp: new Date(),
      labels: {
        ...labels,
        category: 'technical'
      },
      type: 'gauge',
      description: `Technical metric: ${name}`
    });
  }

  // Private helper methods

  private async storeRealTimeMetric(metric: Metric): Promise<void> {
    const key = `realtime:${metric.name}`;
    const member = JSON.stringify({
      ...metric,
      timestamp: metric.timestamp.getTime()
    });
    
    // Add to sorted set with timestamp as score
    await this.redis.zadd(key, metric.timestamp.getTime(), member);
    
    // Trim to last 1000 entries for real-time monitoring
    await this.redis.zremrangebyrank(key, 0, -1001);
  }

  private async processMetricsBuffer(): Promise<void> {
    if (this.metricsBuffer.length === 0) return;

    // Group metrics by name for batch processing
    const grouped = this.metricsBuffer.reduce((acc, metric) => {
      if (!acc[metric.name]) acc[metric.name] = [];
      acc[metric.name].push(metric);
      return acc;
    }, {} as Record<string, Metric[]>);

    // Process each group
    for (const [name, metrics] of Object.entries(grouped)) {
      await this.processMetricGroup(name, metrics);
    }

    // Clear buffer
    this.metricsBuffer = [];
  }

  private async processMetricGroup(name: string, metrics: Metric[]): Promise<void> {
    // Store in long-term storage
    const key = `metrics:${name}`;
    
    for (const metric of metrics) {
      const member = JSON.stringify({
        ...metric,
        timestamp: metric.timestamp.getTime()
      });
      
      await this.redis.zadd(key, metric.timestamp.getTime(), member);
    }

    // Trim old entries based on retention policy
    const cutoff = Date.now() - (this.config.metricsRetention * 24 * 60 * 60 * 1000);
    await this.redis.zremrangebyscore(key, 0, cutoff);
  }

  private matchesFilters(metricLabels: Record<string, string>, filters: Record<string, string>): boolean {
    return Object.entries(filters).every(([key, value]) => 
      metricLabels[key] === value
    );
  }

  private evaluateThreshold(value: number, threshold: number, comparison: string): boolean {
    switch (comparison) {
      case 'gt': return value > threshold;
      case 'lt': return value < threshold;
      case 'gte': return value >= threshold;
      case 'lte': return value <= threshold;
      case 'eq': return value === threshold;
      default: return false;
    }
  }

  private async getSLO(sloId: string): Promise<SLOTarget | null> {
    // This would query the database for SLO configuration
    // Placeholder implementation
    return null;
  }

  private async getAllSLOs(): Promise<SLOTarget[]> {
    // This would query the database for all SLOs
    return this.config.slos || [];
  }

  private async getMetricMeasurements(metric: string, window: string): Promise<Array<{ value: number; timestamp: Date }>> {
    // This would query recent metric measurements
    return [];
  }

  private determineSLOStatus(compliance: number, objective: number): SLOTarget['status'] {
    if (compliance >= objective) return 'healthy';
    if (compliance >= objective * 0.95) return 'degraded';
    return 'violated';
  }

  private calculateBurnRate(sloId: string, window: string): number {
    // Calculate how fast error budget is being consumed
    // Placeholder implementation
    return 0;
  }

  private async getActiveAlertRules(): Promise<AlertRule[]> {
    // Query active alert rules from database
    return [];
  }

  private async evaluateAlertRule(rule: AlertRule, metric: Metric): Promise<boolean> {
    // Check if metric matches rule condition
    if (metric.name !== rule.condition.metric) return false;

    // In a real implementation, you'd aggregate metrics over the time window
    // and compare against the threshold
    return false; // Placeholder
  }

  private async logAlertEvent(rule: AlertRule, metric: Metric): Promise<void> {
    await this.prisma.alertEvent.create({
      data: {
        ruleId: rule.id,
        metricName: metric.name,
        metricValue: metric.value,
        triggeredAt: new Date(),
        severity: rule.severity
      }
    });
  }

  private initializeHealthChecks(): void {
    // Define default health checks
    const defaultChecks: HealthCheck[] = [
      {
        id: 'api_health',
        name: 'API Health',
        url: '/api/health',
        method: 'GET',
        expectedStatus: 200,
        timeout: 5000,
        interval: 60000,
        enabled: true,
        lastCheck: new Date(),
        status: 'healthy',
        responseTime: 0
      },
      {
        id: 'database_health',
        name: 'Database Health',
        url: '/api/health/database',
        method: 'GET',
        expectedStatus: 200,
        timeout: 3000,
        interval: 30000,
        enabled: true,
        lastCheck: new Date(),
        status: 'healthy',
        responseTime: 0
      }
    ];

    defaultChecks.forEach(check => {
      this.healthChecks.set(check.id, check);
    });
  }

  private startMetricsCollection(): void {
    // Start background process to collect system metrics
    if (this.config.enableRealTimeMonitoring) {
      setInterval(() => {
        this.collectSystemMetrics();
      }, 10000); // Every 10 seconds
    }
  }

  private async collectSystemMetrics(): Promise<void> {
    // Collect CPU, memory, disk, network metrics
    const processMetrics = process.resourceUsage();
    
    await this.recordMetric({
      name: 'process_cpu_seconds_total',
      value: processMetrics.cpuUser + processMetrics.cpuSystem,
      timestamp: new Date(),
      labels: { pid: process.pid.toString() },
      type: 'counter',
      unit: 'seconds',
      description: 'Total CPU time used by the process'
    });

    await this.recordMetric({
      name: 'process_memory_bytes',
      value: process.memoryUsage().heapUsed,
      timestamp: new Date(),
      labels: { pid: process.pid.toString() },
      type: 'gauge',
      unit: 'bytes',
      description: 'Memory usage of the process'
    });
  }

  private async executeHealthCheck(check: HealthCheck): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), check.timeout);
      
      const response = await fetch(check.url, {
        method: check.method,
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response.status === check.expectedStatus;
    } catch (error) {
      return false;
    }
  }

  private calculateSystemStatus(healthChecks: HealthCheck[], slos: SLOTarget[]): 'healthy' | 'degraded' | 'down' {
    const unhealthyChecks = healthChecks.filter(c => c.status === 'down').length;
    const violatedSLOs = slos.filter(s => s.status === 'violated').length;
    
    if (unhealthyChecks > 0 || violatedSLOs > 0) {
      return 'down';
    }
    
    const degradedChecks = healthChecks.filter(c => c.status === 'degraded').length;
    const degradedSLOs = slos.filter(s => s.status === 'degraded').length;
    
    if (degradedChecks > 0 || degradedSLOs > 0) {
      return 'degraded';
    }
    
    return 'healthy';
  }

  // Alert action implementations (placeholder)
  private async sendWebhookAlert(target: string, rule: AlertRule, metric: Metric): Promise<void> {
    console.log(`Webhook alert to ${target}:`, { rule, metric });
  }

  private async sendEmailAlert(target: string, rule: AlertRule, metric: Metric): Promise<void> {
    console.log(`Email alert to ${target}:`, { rule, metric });
  }

  private async sendSlackAlert(target: string, rule: AlertRule, metric: Metric): Promise<void> {
    console.log(`Slack alert to ${target}:`, { rule, metric });
  }

  private async sendPagerDutyAlert(target: string, rule: AlertRule, metric: Metric): Promise<void> {
    console.log(`PagerDuty alert to ${target}:`, { rule, metric });
  }

  private async sendSMSAlert(target: string, rule: AlertRule, metric: Metric): Promise<void> {
    console.log(`SMS alert to ${target}:`, { rule, metric });
  }

  private async updateSLOCalculations(metric: Metric): Promise<void> {
    // Update SLO calculations based on incoming metrics
    // This would update real-time SLO compliance calculations
  }
}

// Factory function
export function createMonitoringManager(redis: Redis, prisma: PrismaClient): AdvancedMonitoringManager {
  return new AdvancedMonitoringManager({
    redis,
    prisma,
    metricsRetention: 90,
    alertThresholds: {
      errorRate: 0.05, // 5%
      latencyP95: 1000, // 1 second
      latencyP99: 2000, // 2 seconds
      availability: 0.999, // 99.9%
      errorBudget: 0.001 // 0.1%
    },
    slos: [
      {
        id: 'api_availability',
        name: 'API Availability',
        description: 'API endpoints should be available 99.9% of the time',
        service: 'api',
        objective: 0.999,
        errorBudget: 0.001,
        window: '30d',
        targets: [
          {
            name: 'HTTP 2xx responses',
            metric: 'http_requests_total',
            threshold: 0.999,
            comparison: 'gte',
            weight: 1
          }
        ],
        status: 'healthy',
        lastUpdated: new Date(),
        compliancePercentage: 99.9
      }
    ],
    enableRealTimeMonitoring: true
  });
}

// Export types
export type {
  MonitoringConfig,
  Metric,
  SLOTarget,
  SLOTargetMetric,
  AlertRule,
  AlertCondition,
  AlertAction,
  HealthCheck
};