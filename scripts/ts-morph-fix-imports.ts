import { Project } from "ts-morph";
const project = new Project({ tsConfigFilePath: "tsconfig.json" });

const filesToFix = [
  "src/lib/strategy.ts",
  "src/lib/strategy-execution.ts",
  "src/lib/strategy-risk.ts"
];

for (const file of filesToFix) {
  const sourceFile = project.getSourceFileOrThrow(file);
  sourceFile.fixMissingImports();
  console.log("Fixed imports in", file);
}

project.saveSync();
