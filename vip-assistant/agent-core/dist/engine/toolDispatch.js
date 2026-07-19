let onToolProgress = (data) => { };
export function setToolProgressHandler(handler) {
    onToolProgress = handler;
}
/**
 * Executes a tool using its async generator execute() method,
 * draining any progress events and returning the final ToolResult.
 */
export async function dispatchTool(tool, input, ctx) {
    const iterator = tool.execute(input, ctx);
    let result = await iterator.next();
    while (!result.done) {
        // Process progress event if needed (e.g. log it or yield it)
        try {
            onToolProgress({ toolName: tool.name, event: result.value });
        }
        catch (e) {
            console.error("Error in progress handler:", e);
        }
        if (ctx.verbose) {
            console.log(`[Progress] ${result.value?.label || tool.name}`);
        }
        result = await iterator.next();
    }
    return result.value;
}
