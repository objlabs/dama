export type ProjectKind = 'app' | 'mcp';
export type Language = 'python' | 'rust' | 'typescript';
export type BindingPolicy = 'read-only' | 'approval-required';
export type ResourceType = 'projects' | 'services' | 'mcps' | 'bindings';
export type JsonObject = Record<string, unknown>;

export interface Address { basePath: string; defaultUrl: string }
export interface ProjectInput { name: string; kind: ProjectKind; repository: string; branch: string; domain: string }
export interface Project extends ProjectInput { id: string; createdAt: string }
export type ProjectView = Project & Address;
export interface ServiceInput {
  name: string; kind: ProjectKind; language: Language; sourcePath: string;
  dockerfile: string; buildContext: string; containerPort: number;
  routeSegment: string; healthPath: string; watchPaths: string[];
}
export interface Service extends ServiceInput, Address { id: string; projectId: string; createdAt: string; updatedAt: string }
export type ServiceRow = Omit<Service, keyof Address | 'watchPaths'> & { watchPaths: string };
export interface McpInput {
  name: string; source: 'external' | 'managed'; transport: 'streamable-http';
  endpoint: string; projectId: string | null; serviceId: string | null; credentialRef: string;
}
export interface McpServer extends McpInput { id: string; createdAt: string; status: 'unverified' }
export interface BindingInput { mcpId: string; policy: BindingPolicy }
export interface Binding extends BindingInput { id: string; projectId: string; createdAt: string }
export interface Activity { id: number; action: string; resourceId: string; name: string; createdAt: string }
export interface Snapshot {
  projects: ProjectView[]; services: Service[]; mcps: McpServer[];
  bindings: Binding[]; events: Activity[]; buildJobs: BuildJobSummary[];
  capabilities: { deployment: boolean; mcpExecution: boolean; authentication: boolean };
}
export interface NginxRoute { projectId: string; routeSegment?: string; upstreamPort: number }
export interface NginxManifest { routes: NginxRoute[]; tls?: { certificate?: string; privateKey?: string } }
export type BuildStatus = 'queued' | 'running' | 'deployed' | 'failed';
export interface BuildJobSummary {
  id: string; serviceId: string; commitSha: string; createdAt: string;
  status: BuildStatus; active: number; error: string | null;
}
export interface Release {
  projectId: string; routeSegment: string; upstreamPort: number;
  deploymentId: string; container: string; healthPath: string; image: string;
}
export interface ClaimedBuild extends BuildJob {
  plan: DeploymentPlan | null;
}
export interface BuildJob extends BuildJobSummary {
  source: Omit<DeploymentPlan['source'], 'commit'>;
  build: DeploymentPlan['build'];
}
export interface DeploymentPlan {
  mode: 'preview'; executableByApi: false; projectId: string; serviceId: string; language: Language;
  source: { repository: string; branch: string; sourcePath: string; commit: null };
  basePath: string; defaultUrl: string;
  build: { cwd: 'repository-root'; argv: string[] };
  run: { argv: string[] }; discoverPort: { argv: string[] };
  healthCheck: { path: string; origin: string; timeoutSeconds: number };
  nginxRoute: { projectId: string; routeSegment: string; upstreamPort: null };
  watchPaths: string[]; requirements: string[];
}
