import { Card, CardDescription, CardHeader, CardTitle } from "@imagepit/ui/card";
import { CodeTree } from "@imagepit/ui/code-tree";
import { ExecPair } from "@imagepit/ui/exec-pair";
import { Figure } from "@imagepit/ui/figure";
import { FileTree } from "@imagepit/ui/file-tree";
import { LinkCard } from "@imagepit/ui/link-card";
import { MermaidDiagram } from "@imagepit/ui/mermaid-diagram";
import { Step, Steps } from "@imagepit/ui/steps";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@imagepit/ui/table";
import { XStatusCard } from "@imagepit/ui/x-status-card";
import type { ReactNode } from "react";

export const mermaidSource = "flowchart LR\n  A[下書き] --> B[確認] --> C[公開]";
const codeCapabilities = { copyButton: false };

export function imagepitBlockSamples(diagram: string | null) {
  return [
    {
      key: "code-tree",
      title: "Code Tree",
      view: <CodeTree title="サンプルコード" interactive={false}
        files={[{ path: "src/index.ts", language: "typescript", code: 'console.log("Hello");' }]}
        capabilities={codeCapabilities} />,
    },
    {
      key: "file-tree",
      title: "File Tree",
      view: <FileTree title="フォルダ構成" entries={[
        { name: "src", kind: "directory", defaultOpen: true, children: [{ name: "index.ts", kind: "file" }] },
        { name: "README.md", kind: "file" },
      ]} />,
    },
    {
      key: "exec-pair",
      title: "Exec Pair",
      view: <ExecPair input={{ language: "bash", code: "npm test", title: "コマンド" }}
        output={{ language: "text", code: "Tests passed", title: "実行結果" }}
        capabilities={{ copyButton: false, outputToggle: false }} />,
    },
    {
      key: "steps",
      title: "Steps",
      view: <Steps>
        <Step number={1} title="準備する"><p>必要な資料をそろえる。</p></Step>
        <Step number={2} title="試す"><p>手順を実行して結果を確認する。</p></Step>
      </Steps>,
    },
    {
      key: "card",
      title: "Card",
      view: <Card>
        <CardHeader>
          <CardTitle>研修のねらい</CardTitle>
          <CardDescription>学んだことを、実際の業務で試す。</CardDescription>
        </CardHeader>
      </Card>,
    },
    {
      key: "table",
      title: "Table",
      view: <Table verticalLines>
        <TableHeader>
          <TableRow><TableHead>項目</TableHead><TableHead>確認結果</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <TableRow><TableCell>挿入</TableCell><TableCell>済</TableCell></TableRow>
          <TableRow><TableCell>保存</TableCell><TableCell>未確認</TableCell></TableRow>
        </TableBody>
      </Table>,
    },
    {
      key: "figure",
      title: "Figure",
      view: <Figure alt="Presenton" caption="図1　Presentonの画面例"
        src="/create_presentation.png" width={560} height={315} />,
    },
    {
      key: "mermaid-diagram",
      title: "Mermaid Diagram",
      view: <MermaidDiagram chart={mermaidSource} caption="図2　公開までの流れ">
        {diagram && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={diagram} alt="Mermaid Diagram" data-mermaid-source={mermaidSource} width={500} height={100}
            style={{ display: "block", maxWidth: "100%", objectFit: "contain", margin: "0 auto" }} />
        )}
      </MermaidDiagram>,
    },
    {
      key: "link-card",
      title: "Link Card",
      view: <LinkCard url="https://example.com/guide" title="参照資料"
        description="スライドに載せる関連ページの概要。" siteName="Example" />,
    },
    {
      key: "x-status-card",
      title: "X Status Card",
      view: <XStatusCard url="https://x.com/example/status/1"
        statusId="1" username="example" authorName="投稿の表示例" />,
    },
  ] satisfies { key: string; title: string; view: ReactNode }[];
}
