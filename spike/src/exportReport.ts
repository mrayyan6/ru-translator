import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import type { Phase0Report } from '@core/types';
import { toJson, toMarkdown } from '@core/report';

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export interface ExportResult {
  markdownUri: string;
  jsonUri: string;
  shared: boolean;
}

/**
 * Writes the report to the documents directory and offers the share sheet.
 * Documents, not cache — a report that the OS may delete before the tester
 * gets round to sending it is not evidence.
 */
export async function exportReport(report: Phase0Report): Promise<ExportResult> {
  const base = `phase0-${report.device.platform}-${stamp()}`;

  const md = new File(Paths.document, `${base}.md`);
  md.create({ overwrite: true });
  md.write(toMarkdown(report));

  const json = new File(Paths.document, `${base}.json`);
  json.create({ overwrite: true });
  json.write(toJson(report));

  let shared = false;
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(md.uri, {
      mimeType: 'text/markdown',
      dialogTitle: 'Phase 0 spike report',
      UTI: 'net.daringfireball.markdown',
    });
    shared = true;
  }

  return { markdownUri: md.uri, jsonUri: json.uri, shared };
}
