/**
 * symbols.ts —— 单文件静态解析：符号与导入（M2）
 *
 * 解析流程（TypeScript Compiler API，零新增依赖）：
 *
 * parseFile(absPath)
 *     ├─> ts.createSourceFile                词法/语法解析（js/json 分流）
 *     ├─> 遍历 AST：
 *     │     ├─> ImportDeclaration / ExportDeclaration ...from -> 静态导入
 *     │     ├─> CallExpression(require) / ImportCall        -> require 与动态导入
 *     │     │     └─ 参数非字符串字面量 -> dynamic: true（unknown 解析目标）
 *     │     └─> Function/Class/Method/Arrow(顶层) 声明      -> 符号（名字+行号）
 *     └─> 返回 { symbols, imports }
 */

import ts from "typescript";
import { readFileSync } from "node:fs";

export interface SymbolEntry {
  name: string;
  kind: "function" | "class" | "method" | "const" | "enum";
  line: number;
}

export interface ImportEntry {
  /** 源码中的导入说明符（如 ./server-host、node:fs、lodash） */
  spec: string;
  /** 解析结果：相对路径文件（仓库内路径）/ 外部包名 / unknown（动态引用） */
  resolved: string | null;
  kind: "file" | "external" | "unknown";
  /** true = require(变量) 或 import(表达式)，无法静态解析 */
  dynamic: boolean;
}

export interface FileParseResult {
  symbols: SymbolEntry[];
  imports: ImportEntry[];
}

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** 解析单个 JS/JSON 文件，提取符号与导入 */
export function parseFile(absPath: string): FileParseResult {
  const text = readFileSync(absPath, "utf-8");
  const isJson = absPath.endsWith(".json");

  if (isJson) {
    // JSON 无符号无导入；仅校验可解析，便于后续引用检测
    try {
      JSON.parse(text);
    } catch {
      // 非法 JSON 不阻断流程，标记在调用方处理
    }
    return { symbols: [], imports: [] };
  }

  const sf = ts.createSourceFile(absPath, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const symbols: SymbolEntry[] = [];
  const imports: ImportEntry[] = [];

  function pushImport(spec: string | null, dynamic: boolean) {
    if (spec === null) {
      imports.push({ spec: "<dynamic>", resolved: null, kind: "unknown", dynamic: true });
    } else if (spec.startsWith(".") || spec.startsWith("/")) {
      imports.push({ spec, resolved: null, kind: "file", dynamic });
    } else {
      // node: 前缀与普通裸导入均视为外部（node 内置或 npm 包）
      imports.push({ spec, resolved: spec, kind: "external", dynamic });
    }
  }

  /**
   * 从路径表达式中提取字符串字面量路径（启发式）。
   * 覆盖 path.join(__dirname, "server-host.js") / "./a" + name 等动态拼接模式。
   */
  function extractPathLiteral(expr: ts.Expression): string | null {
    const lits: string[] = [];
    (function walk(n: ts.Node) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        lits.push(n.text);
      }
      ts.forEachChild(n, walk);
    })(expr);
    // 取最后一个含路径特征的字面量（join(__dirname, "a", "b.js") 中末尾才是文件名）
    const candidates = lits.filter((s) => /[./\\]/.test(s));
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  /** 动态字面量统一按相对路径处理（path.join(__dirname, "x") 的 __dirname 即 from 文件目录） */
  function asRelative(p: string | null): string | null {
    if (p === null) return null;
    return p.startsWith(".") || p.startsWith("/") ? p : `./${p}`;
  }

  function visit(node: ts.Node) {
    // 静态 import / export ... from
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      pushImport(node.moduleSpecifier.text, false);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      pushImport(node.moduleSpecifier.text, false);
    }
    // require(...)：字符串字面量为静态；路径表达式则启发式提取字面量，失败标 unknown
    else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0];
      if (ts.isStringLiteral(arg)) {
        pushImport(arg.text, false);
      } else {
        pushImport(asRelative(extractPathLiteral(arg)), true);
      }
    }
    // fork(...)：utilityProcess.fork / child_process.fork（进程启动，非模块导入，但构成运行时依赖）
    else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "fork" &&
      node.arguments.length >= 1
    ) {
      const arg = node.arguments[0];
      const lit = ts.isStringLiteral(arg) ? arg.text : extractPathLiteral(arg);
      pushImport(asRelative(lit), true);
    }
    // import(...) 动态导入（CallExpression 且 callee 为 import 关键字）
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const arg = node.arguments[0];
      if (arg && ts.isStringLiteral(arg)) {
        pushImport(arg.text, true);
      } else {
        const lit = arg ? extractPathLiteral(arg) : null;
        pushImport(lit, true);
      }
    }
    // 符号提取
    else if (ts.isFunctionDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: "function", line: lineOf(sf, node) });
    } else if (ts.isClassDeclaration(node) && node.name) {
      symbols.push({ name: node.name.text, kind: "class", line: lineOf(sf, node) });
    } else if (
      ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)
    ) {
      symbols.push({ name: node.name.text, kind: "method", line: lineOf(sf, node) });
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.parent.parent &&
      ts.isVariableStatement(node.parent.parent)
    ) {
      const init = node.initializer;
      // 顶层箭头函数/函数表达式的 const 视为函数符号
      if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
        symbols.push({ name: node.name.text, kind: "function", line: lineOf(sf, node) });
      } else if (init && ts.isObjectLiteralExpression(init)) {
        // 顶层对象（常作为配置/命名空间）记为 const 符号
        symbols.push({ name: node.name.text, kind: "const", line: lineOf(sf, node) });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sf);
  return { symbols, imports };
}
