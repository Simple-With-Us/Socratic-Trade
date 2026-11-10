import { Project, SyntaxKind } from "ts-morph";
import * as fs from "fs";
import * as path from "path";

const project = new Project({
    tsConfigFilePath: "tsconfig.json",
});

const strategyFile = project.getSourceFileOrThrow("src/lib/strategy.ts");
const targetFile = project.createSourceFile("src/lib/strategy-risk.ts", "", { overwrite: true });

// The functions to move
const functionsToMove = [
    "shouldEscalateDecision",
    "approvedEscalationsFromDecision",
    "isRiskAddingOpening",
    "applyRedTeamHalfSize",
    "mapWithConcurrency",
    "allowedProposalSides",
    "deterministicBearFilter",
    "selectThesisStat",
    "shouldSkipNegativeExpectancy",
    "applyCorrelationClusterGate",
    "applyEarningsBlackoutTag",
    "applyRiskReceipts",
    "applyDeterministicSizing"
];

// The interfaces/types to move that are closely tied
const typesToMove: string[] = [];

console.log("Moving declarations...");

for (const name of typesToMove) {
    const decl = strategyFile.getInterface(name) || strategyFile.getClass(name) || strategyFile.getTypeAlias(name);
    if (decl) {
        targetFile.addStatements(decl.getText());
        decl.remove();
        console.log(`Moved ${name}`);
    }
}

for (const name of functionsToMove) {
    const decls = strategyFile.getFunctions().filter(f => f.getName() === name);
    for (const decl of decls) {
        targetFile.addStatements(decl.getText());
        decl.remove();
        console.log(`Moved function ${name}`);
    }
}

console.log("Fixing missing imports in new file...");
targetFile.fixMissingImports();

console.log("Fixing missing imports in original file...");
strategyFile.fixMissingImports();

console.log("Saving files...");
project.saveSync();
console.log("Done!");

