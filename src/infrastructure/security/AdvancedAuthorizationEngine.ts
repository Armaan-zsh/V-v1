import { PrismaClient } from '@prisma/client';
import { Redis } from '@upstash/redis';
import { nanoid } from 'nanoid';

export interface ABACConfig {
  redis: Redis;
  prisma: PrismaClient;
  defaultPolicies: Policy[];
  enableAuditLogging: boolean;
  cacheTtl: number;
  maxPolicyDepth: number;
}

export interface User {
  id: string;
  email: string;
  role: string;
  attributes: UserAttribute[];
  groups: string[];
  context: UserContext;
}

export interface UserAttribute {
  key: string;
  value: string | number | boolean | string[];
  namespace?: string;
  type: 'static' | 'dynamic' | 'computed';
  source: string; // Where the attribute came from
  expiresAt?: Date;
}

export interface UserContext {
  ipAddress: string;
  userAgent: string;
  location?: {
    country: string;
    region: string;
    city: string;
  };
  device: {
    type: 'mobile' | 'desktop' | 'tablet';
    os: string;
    browser: string;
  };
  session: {
    id: string;
    duration: number;
    riskScore: number;
  };
  timeContext: {
    hour: number;
    dayOfWeek: number;
    timezone: string;
    businessHours: boolean;
  };
}

export interface Resource {
  id: string;
  type: string;
  owner?: string;
  attributes: ResourceAttribute[];
  classification: 'public' | 'internal' | 'confidential' | 'restricted';
}

export interface ResourceAttribute {
  key: string;
  value: any;
  namespace?: string;
}

export interface Action {
  type: 'read' | 'write' | 'delete' | 'execute' | 'admin';
  scope: string;
  conditions?: ActionCondition[];
}

export interface ActionCondition {
  attribute: string;
  operator: 'equals' | 'not_equals' | 'contains' | 'greater_than' | 'less_than' | 'in' | 'not_in';
  value: any;
}

export interface Policy {
  id: string;
  name: string;
  description: string;
  effect: 'allow' | 'deny';
  priority: number; // Higher number = higher priority
  enabled: boolean;
  
  // Policy rules
  subjects: SubjectRule[]; // Who the policy applies to
  resources: ResourceRule[]; // What resources
  actions: ActionRule[]; // What actions
  conditions: PolicyCondition[]; // Additional conditions
  
  // Attributes evaluation
  requireAttributes?: AttributeRequirement[];
  
  // Time-based rules
  timeConstraints?: {
    startTime?: string;
    endTime?: string;
    daysOfWeek?: number[];
    timezone?: string;
  };
  
  // Risk-based rules
  maxRiskScore?: number;
  minRiskScore?: number;
  
  // Audit
  audit: {
    logAccess: boolean;
    logDeny: boolean;
    required: boolean;
  };
}

export interface SubjectRule {
  type: 'user' | 'role' | 'group' | 'attribute' | 'context';
  value: string | string[] | AttributeMatch;
  operator?: 'equals' | 'in' | 'matches' | 'contains';
}

export interface ResourceRule {
  type: 'type' | 'id' | 'owner' | 'attribute' | 'classification';
  value: any;
  operator?: 'equals' | 'in' | 'matches' | 'contains';
}

export interface ActionRule {
  type: 'read' | 'write' | 'delete' | 'execute' | 'admin' | 'custom';
  scope?: string;
}

export interface PolicyCondition {
  type: 'attribute' | 'context' | 'time' | 'risk';
  attribute: string;
  operator: string;
  value: any;
}

export interface AttributeRequirement {
  key: string;
  required: boolean;
  validator?: (value: any) => boolean;
}

export interface AttributeMatch {
  key: string;
  value: any;
  operator: 'equals' | 'contains' | 'in' | 'greater_than' | 'less_than';
}

export interface AuthorizationResult {
  allowed: boolean;
  reason: string;
  policy?: Policy;
  requiredAttributes?: string[];
  riskScore: number;
  audit: {
    policyId?: string;
    timestamp: Date;
    userId: string;
    resource: string;
    action: string;
  };
}

export class AdvancedAuthorizationEngine {
  private redis: Redis;
  private prisma: PrismaClient;
  private config: ABACConfig;
  private policyCache: Map<string, Policy[]> = new Map();

  constructor(config: ABACConfig) {
    this.redis = config.redis;
    this.prisma = config.prisma;
    this.config = config;
    
    // Load default policies
    this.loadDefaultPolicies();
  }

  /**
   * Evaluate authorization request using ABAC
   */
  async authorize(
    user: User,
    resource: Resource,
    action: Action
  ): Promise<AuthorizationResult> {
    try {
      const startTime = Date.now();
      
      // 1. Get applicable policies
      const policies = await this.getApplicablePolicies(user, resource, action);
      
      // 2. Sort by priority (highest first)
      const sortedPolicies = policies.sort((a, b) => b.priority - a.priority);
      
      // 3. Evaluate each policy
      for (const policy of sortedPolicies) {
        const result = await this.evaluatePolicy(policy, user, resource, action);
        
        if (result.allowed) {
          // Log successful authorization
          await this.logAuthorization(true, policy, user, resource, action, Date.now() - startTime);
          
          return result;
        }
      }
      
      // 4. No policy allowed access
      const denyResult: AuthorizationResult = {
        allowed: false,
        reason: 'No policy allows this action',
        riskScore: user.context.session.riskScore,
        audit: {
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
      
      await this.logAuthorization(false, undefined, user, resource, action, Date.now() - startTime);
      
      return denyResult;

    } catch (error) {
      console.error('Authorization error:', error);
      
      return {
        allowed: false,
        reason: 'Authorization system error',
        riskScore: 999,
        audit: {
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
  }

  /**
   * Get policies applicable to the request
   */
  private async getApplicablePolicies(
    user: User,
    resource: Resource,
    action: Action
  ): Promise<Policy[]> {
    const cacheKey = `abac:policies:${user.role}:${resource.type}:${action.type}`;
    
    // Check cache first
    if (this.policyCache.has(cacheKey)) {
      return this.policyCache.get(cacheKey)!;
    }
    
    // Get from database
    const policies = await this.prisma.abacPolicy.findMany({
      where: {
        enabled: true,
        OR: [
          // Global policies
          { scope: 'global' },
          // Role-specific policies
          { subjects: { some: { value: user.role } } },
          // User-specific policies
          { subjects: { some: { value: user.id } } },
          // Group policies
          { subjects: { some: { value: { in: user.groups } } } }
        ]
      },
      include: {
        subjects: true,
        resources: true,
        actions: true,
        conditions: true,
        requirements: true
      }
    });
    
    // Convert database format to Policy interface
    const policyObjects: Policy[] = policies.map(p => this.convertDbPolicyToPolicy(p));
    
    // Cache policies
    this.policyCache.set(cacheKey, policyObjects);
    
    return policyObjects;
  }

  /**
   * Evaluate specific policy against request
   */
  private async evaluatePolicy(
    policy: Policy,
    user: User,
    resource: Resource,
    action: Action
  ): Promise<AuthorizationResult> {
    // 1. Check subject rules
    if (!this.evaluateSubjects(policy.subjects, user)) {
      return {
        allowed: false,
        reason: 'Subject does not match policy',
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 2. Check resource rules
    if (!this.evaluateResources(policy.resources, resource)) {
      return {
        allowed: false,
        reason: 'Resource does not match policy',
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 3. Check action rules
    if (!this.evaluateActions(policy.actions, action)) {
      return {
        allowed: false,
        reason: 'Action does not match policy',
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 4. Check conditions
    if (!this.evaluateConditions(policy.conditions, user, resource, action)) {
      return {
        allowed: false,
        reason: 'Conditions not satisfied',
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 5. Check time constraints
    if (!this.evaluateTimeConstraints(policy.timeConstraints, user.context.timeContext)) {
      return {
        allowed: false,
        reason: 'Time constraints not satisfied',
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 6. Check risk constraints
    if (!this.evaluateRiskConstraints(policy, user.context.session.riskScore)) {
      return {
        allowed: false,
        reason: 'Risk score too high',
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 7. Check attribute requirements
    const missingAttributes = await this.checkAttributeRequirements(policy.requireAttributes || [], user);
    if (missingAttributes.length > 0) {
      return {
        allowed: false,
        reason: `Missing required attributes: ${missingAttributes.join(', ')}`,
        requiredAttributes: missingAttributes,
        riskScore: user.context.session.riskScore,
        audit: {
          policyId: policy.id,
          timestamp: new Date(),
          userId: user.id,
          resource: resource.id,
          action: action.type
        }
      };
    }
    
    // 8. Policy allows the action
    return {
      allowed: policy.effect === 'allow',
      reason: policy.effect === 'allow' ? 'Authorized by policy' : 'Denied by policy',
      policy,
      riskScore: user.context.session.riskScore,
      audit: {
        policyId: policy.id,
        timestamp: new Date(),
        userId: user.id,
        resource: resource.id,
        action: action.type
      }
    };
  }

  /**
   * Evaluate subject rules
   */
  private evaluateSubjects(subjects: SubjectRule[], user: User): boolean {
    for (const subject of subjects) {
      switch (subject.type) {
        case 'user':
          if (this.matchesValue(subject.value, user.id)) return true;
          break;
          
        case 'role':
          if (this.matchesValue(subject.value, user.role)) return true;
          break;
          
        case 'group':
          if (this.matchesValue(subject.value, user.groups)) return true;
          break;
          
        case 'attribute':
          if (this.evaluateAttributeMatch(subject.value as AttributeMatch, user.attributes)) return true;
          break;
          
        case 'context':
          if (this.evaluateAttributeMatch(subject.value as AttributeMatch, this.flattenContext(user.context))) return true;
          break;
      }
    }
    
    return false;
  }

  /**
   * Evaluate resource rules
   */
  private evaluateResources(resources: ResourceRule[], resource: Resource): boolean {
    for (const res of resources) {
      switch (res.type) {
        case 'type':
          if (this.matchesValue(res.value, resource.type)) return true;
          break;
          
        case 'id':
          if (this.matchesValue(res.value, resource.id)) return true;
          break;
          
        case 'owner':
          if (this.matchesValue(res.value, resource.owner)) return true;
          break;
          
        case 'attribute':
          if (this.evaluateAttributeMatch(res.value as AttributeMatch, resource.attributes)) return true;
          break;
          
        case 'classification':
          if (this.matchesValue(res.value, resource.classification)) return true;
          break;
      }
    }
    
    return false;
  }

  /**
   * Evaluate action rules
   */
  private evaluateActions(actions: ActionRule[], action: Action): boolean {
    return actions.some(a => {
      if (a.type === action.type) {
        return !a.scope || a.scope === action.scope;
      }
      return false;
    });
  }

  /**
   * Evaluate policy conditions
   */
  private evaluateConditions(
    conditions: PolicyCondition[],
    user: User,
    resource: Resource,
    action: Action
  ): boolean {
    // All conditions must be satisfied
    return conditions.every(condition => {
      const value = this.getConditionValue(condition, user, resource, action);
      return this.evaluateOperator(condition.operator, value, condition.value);
    });
  }

  /**
   * Evaluate time constraints
   */
  private evaluateTimeConstraints(
    timeConstraints: any,
    timeContext: UserContext['timeContext']
  ): boolean {
    if (!timeConstraints) return true;
    
    // Check day of week
    if (timeConstraints.daysOfWeek && 
        !timeConstraints.daysOfWeek.includes(timeContext.dayOfWeek)) {
      return false;
    }
    
    // Check business hours if specified
    if (timeConstraints.businessHours && !timeContext.businessHours) {
      return false;
    }
    
    return true;
  }

  /**
   * Evaluate risk constraints
   */
  private evaluateRiskConstraints(policy: Policy, riskScore: number): boolean {
    if (policy.maxRiskScore !== undefined && riskScore > policy.maxRiskScore) {
      return false;
    }
    
    if (policy.minRiskScore !== undefined && riskScore < policy.minRiskScore) {
      return false;
    }
    
    return true;
  }

  /**
   * Check attribute requirements
   */
  private async checkAttributeRequirements(
    requirements: AttributeRequirement[],
    user: User
  ): Promise<string[]> {
    const missing: string[] = [];
    
    for (const req of requirements) {
      const hasAttribute = user.attributes.some(attr => attr.key === req.key);
      
      if (req.required && !hasAttribute) {
        missing.push(req.key);
      } else if (hasAttribute && req.validator) {
        const attribute = user.attributes.find(attr => attr.key === req.key)!;
        if (!req.validator(attribute.value)) {
          missing.push(req.key);
        }
      }
    }
    
    return missing;
  }

  // Helper methods

  private matchesValue(pattern: any, value: any): boolean {
    if (Array.isArray(pattern)) {
      return pattern.includes(value);
    }
    if (typeof pattern === 'string' && pattern.includes('*')) {
      const regex = new RegExp(pattern.replace(/\*/g, '.*'));
      return regex.test(value);
    }
    return pattern === value;
  }

  private evaluateAttributeMatch(match: AttributeMatch, attributes: any[]): boolean {
    const attribute = attributes.find(attr => attr.key === match.key);
    if (!attribute) return false;
    
    return this.evaluateOperator(match.operator, attribute.value, match.value);
  }

  private evaluateOperator(operator: string, left: any, right: any): boolean {
    switch (operator) {
      case 'equals': return left === right;
      case 'not_equals': return left !== right;
      case 'contains': return String(left).includes(String(right));
      case 'greater_than': return Number(left) > Number(right);
      case 'less_than': return Number(left) < Number(right);
      case 'in': return Array.isArray(right) && right.includes(left);
      case 'not_in': return Array.isArray(right) && !right.includes(left);
      default: return false;
    }
  }

  private getConditionValue(condition: PolicyCondition, user: User, resource: Resource, action: Action): any {
    // Implement logic to extract condition value from user/resource/action/context
    return null; // Placeholder
  }

  private flattenContext(context: UserContext): any[] {
    const flat: any[] = [];
    
    Object.entries(context).forEach(([key, value]) => {
      if (typeof value === 'object' && value !== null) {
        Object.entries(value).forEach(([subKey, subValue]) => {
          flat.push({ key: `${key}.${subKey}`, value: subValue });
        });
      } else {
        flat.push({ key, value });
      }
    });
    
    return flat;
  }

  private loadDefaultPolicies(): void {
    // Load default policies from configuration
    // This would typically load from database or configuration files
  }

  private convertDbPolicyToPolicy(dbPolicy: any): Policy {
    // Convert database format to Policy interface
    return {
      id: dbPolicy.id,
      name: dbPolicy.name,
      description: dbPolicy.description,
      effect: dbPolicy.effect,
      priority: dbPolicy.priority,
      enabled: dbPolicy.enabled,
      subjects: [], // Convert from database
      resources: [], // Convert from database
      actions: [], // Convert from database
      conditions: [], // Convert from database
      audit: {
        logAccess: dbPolicy.logAccess,
        logDeny: dbPolicy.logDeny,
        required: dbPolicy.required
      }
    };
  }

  /**
   * Log authorization decision
   */
  private async logAuthorization(
    allowed: boolean,
    policy: Policy | undefined,
    user: User,
    resource: Resource,
    action: Action,
    duration: number
  ): Promise<void> {
    if (this.config.enableAuditLogging) {
      await this.prisma.authorizationLog.create({
        data: {
          userId: user.id,
          resourceId: resource.id,
          action: action.type,
          allowed,
          policyId: policy?.id,
          duration,
          context: {
            ipAddress: user.context.ipAddress,
            userAgent: user.context.userAgent,
            riskScore: user.context.session.riskScore
          }
        }
      });
    }
  }
}

// Factory function
export function createABACEngine(redis: Redis, prisma: PrismaClient): AdvancedAuthorizationEngine {
  return new AdvancedAuthorizationEngine({
    redis,
    prisma,
    defaultPolicies: [],
    enableAuditLogging: true,
    cacheTtl: 3600,
    maxPolicyDepth: 10
  });
}

// Export types
export type {
  ABACConfig,
  User,
  UserAttribute,
  UserContext,
  Resource,
  ResourceAttribute,
  Action,
  Policy,
  AuthorizationResult
};