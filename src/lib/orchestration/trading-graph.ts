import type { TradingPolicy, TradeProposal, ExecutionMode } from "../types";

export type GraphState = 
  | "INIT"
  | "DATA_GATHERING"
  | "ALTERNATIVE_DATA_ANALYSIS"
  | "FUNDAMENTAL_PROPOSING"
  | "RED_TEAM_REVIEW"
  | "EXECUTION"
  | "COMPLETED"
  | "FAILED";

export interface GraphTransitionRecord {
  from: GraphState;
  to: GraphState;
  timestamp: number;
  durationMs: number;
}

export interface GraphContext {
  runId: string;
  policy: TradingPolicy;
  mode: ExecutionMode;
  userId: string;
  connectedAccountId: string;
  proposals: TradeProposal[];
  errors: Error[];
  // Extensible for future nodes & alternative data
  metadata: Record<string, unknown>;
}

export interface GraphNode {
  name: GraphState;
  execute: (context: GraphContext) => Promise<{ nextState: GraphState; context: GraphContext }>;
}

export interface TradingGraphOptions {
  onTransition?: (record: GraphTransitionRecord) => void;
  initialState?: GraphState;
}

export class TradingGraph {
  private nodes = new Map<GraphState, GraphNode>();
  private currentState: GraphState = "INIT";
  private transitions: GraphTransitionRecord[] = [];
  private onTransition?: (record: GraphTransitionRecord) => void;
  
  constructor(private context: GraphContext, options?: TradingGraphOptions) {
    if (options?.initialState) {
      this.currentState = options.initialState;
    }
    this.onTransition = options?.onTransition;
  }

  public registerNode(node: GraphNode): void {
    this.nodes.set(node.name, node);
  }

  public hasNode(state: GraphState): boolean {
    return this.nodes.has(state);
  }

  public getCurrentState(): GraphState {
    return this.currentState;
  }

  public getTransitions(): GraphTransitionRecord[] {
    return [...this.transitions];
  }

  public async run(): Promise<GraphContext> {
    while (this.currentState !== "COMPLETED" && this.currentState !== "FAILED") {
      const node = this.nodes.get(this.currentState);
      if (!node) {
        this.context.errors.push(new Error(`Node not found for state: ${this.currentState}`));
        this.currentState = "FAILED";
        break;
      }
      
      const fromState = this.currentState;
      const startTime = Date.now();
      try {
        const result = await node.execute(this.context);
        const durationMs = Date.now() - startTime;
        const transition: GraphTransitionRecord = {
          from: fromState,
          to: result.nextState,
          timestamp: startTime,
          durationMs,
        };
        this.transitions.push(transition);
        this.onTransition?.(transition);

        this.currentState = result.nextState;
        this.context = result.context;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const transition: GraphTransitionRecord = {
          from: fromState,
          to: "FAILED",
          timestamp: startTime,
          durationMs,
        };
        this.transitions.push(transition);
        this.onTransition?.(transition);

        this.context.errors.push(error instanceof Error ? error : new Error(String(error)));
        this.currentState = "FAILED";
      }
    }
    
    // Attach transition history to metadata for full observability and trajectory tracking
    this.context.metadata = {
      ...this.context.metadata,
      graphTransitions: this.transitions,
      graphFinalState: this.currentState,
    };

    return this.context;
  }
}
