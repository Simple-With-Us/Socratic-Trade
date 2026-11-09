import { Project } from "ts-morph";

const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const executionExports = [
    "executeProposal",
    "reconcilePendingFills",
    "reconcilePlacementError",
    "flagStalePlacingIntents",
    "coerceProtectiveExitToMarket",
    "LiveApprovalConfirmation",
    "LiveApprovalConfirmationError",
    "PlacementReconcileOutcome"
];

const riskExports = [
    "shouldEscalateDecision",
    "approvedEscalationsFromDecision",
    "isRiskAddingOpening",
    "applyRedTeamHalfSize",
    "allowedProposalSides",
    "deterministicBearFilter",
    "selectThesisStat",
    "shouldSkipNegativeExpectancy",
    "applyCorrelationClusterGate",
    "applyEarningsBlackoutTag",
    "applyRiskReceipts",
    "applyDeterministicSizing"
];

for (const sourceFile of project.getSourceFiles()) {
    // Skip strategy.ts itself to avoid messing with its internal imports if they are already correct
    if (sourceFile.getFilePath().endsWith("src/lib/strategy.ts")) {
        continue;
    }
    
    let changed = false;
    const imports = sourceFile.getImportDeclarations();
    for (const imp of imports) {
        const moduleSpecifier = imp.getModuleSpecifierValue();
        if (moduleSpecifier === "strategy" || moduleSpecifier.endsWith("/strategy") || moduleSpecifier === "@/lib/strategy") {
            
            const namedImports = imp.getNamedImports();
            const execImportsToMove: string[] = [];
            const riskImportsToMove: string[] = [];
            
            for (const named of [...namedImports]) { // copy array to iterate safely while removing
                const name = named.getName();
                if (executionExports.includes(name)) {
                    execImportsToMove.push(name);
                    named.remove();
                    changed = true;
                } else if (riskExports.includes(name)) {
                    riskImportsToMove.push(name);
                    named.remove();
                    changed = true;
                }
            }
            
            if (execImportsToMove.length > 0) {
                const newModule = moduleSpecifier + "-execution";
                const existingExecImport = sourceFile.getImportDeclarations().find(i => i.getModuleSpecifierValue() === newModule);
                if (existingExecImport) {
                    existingExecImport.addNamedImports(execImportsToMove);
                } else {
                    sourceFile.addImportDeclaration({
                        moduleSpecifier: newModule,
                        namedImports: execImportsToMove
                    });
                }
            }
            
            if (riskImportsToMove.length > 0) {
                const newModule = moduleSpecifier + "-risk";
                const existingRiskImport = sourceFile.getImportDeclarations().find(i => i.getModuleSpecifierValue() === newModule);
                if (existingRiskImport) {
                    existingRiskImport.addNamedImports(riskImportsToMove);
                } else {
                    sourceFile.addImportDeclaration({
                        moduleSpecifier: newModule,
                        namedImports: riskImportsToMove
                    });
                }
            }
            
            if (imp.getNamedImports().length === 0 && !imp.getDefaultImport() && !imp.getNamespaceImport()) {
                imp.remove();
            }
        }
    }
    
    if (changed) {
        console.log("Updated", sourceFile.getFilePath());
    }
}
project.saveSync();
