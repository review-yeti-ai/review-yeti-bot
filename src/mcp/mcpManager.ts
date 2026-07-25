import { Context7Adapter } from './context7Adapter';
import { ProductlaneMCPAdapter } from './productlaneAdapter';
import { McpItemConfig } from '../config/schema';

export class MCPManager {
  private readonly context7?: Context7Adapter;
  private readonly productlane?: ProductlaneMCPAdapter;

  constructor(mcps: McpItemConfig[] = []) {
    for (const mcp of mcps) {
      if (!mcp.enabled) continue;
      if (mcp.name === 'context7') {
        this.context7 = new Context7Adapter();
      } else if (mcp.name === 'productlane') {
        this.productlane = new ProductlaneMCPAdapter();
      }
    }
  }

  getContext7(): Context7Adapter | undefined {
    return this.context7;
  }

  getProductlane(): ProductlaneMCPAdapter | undefined {
    return this.productlane;
  }
}
