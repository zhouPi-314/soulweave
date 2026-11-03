/**
 * SoulWeave：Live2D 形象存储
 *
 * 【为什么和角色分开】
 * 形象是「外观资产」，角色是「人格 + 大脑」。两者是多对一关系：
 * 同一个形象可以给不同角色用，一个角色也可以换形象或干脆不显示。
 * 所以形象单独存 live2d.json，角色只存一个 live2dModelId 指针。
 *
 * 形象的名字独立于角色名（用户明确要求）：你可以把形象叫「小糖」「冬日ver.」，
 * 角色仍然叫「冰糖」。
 */
import fs from 'node:fs';
import path from 'node:path';

export interface Live2DModel {
  id: string;
  /** 形象名，独立于角色名 */
  name: string;
  /** imported=用户导入的模型目录；builtin=内置示例 */
  source: 'imported' | 'builtin';
  /** 模型目录或 .model3.json 的绝对路径 */
  path: string;
  /** 是否在桌面上显示（关掉=只在设置里保留，不出现在窗口） */
  visible: boolean;
  /** 导入时间 */
  createdAt: string;
  /** 备注 */
  note?: string;
}

interface Live2DFile {
  version: number;
  models: Live2DModel[];
}

const FILE_VERSION = 1;

export class Live2DStore {
  private file: string;
  private data: Live2DFile;

  constructor(dir: string) {
    this.file = path.join(dir, 'live2d.json');
    this.data = this.load();
  }

  private load(): Live2DFile {
    try {
      if (fs.existsSync(this.file)) {
        const j = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        if (j && Array.isArray(j.models)) {
          return {
            version: FILE_VERSION,
            models: j.models.map((m: any) => ({
              id: String(m.id || ''),
              name: String(m.name || '未命名形象'),
              source: m.source === 'builtin' ? 'builtin' : 'imported',
              path: String(m.path || ''),
              visible: m.visible !== false,
              createdAt: String(m.createdAt || new Date().toISOString()),
              note: m.note ? String(m.note).slice(0, 200) : undefined,
            })).filter((m: Live2DModel) => m.id),
          };
        }
      }
    } catch (e) { /* 坏文件回落空列表 */ }
    return { version: FILE_VERSION, models: [] };
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
    } catch (e) { /* 写失败不抛 */ }
  }

  list(): Live2DModel[] { return this.data.models.slice(); }

  get(id: string): Live2DModel | undefined { return this.data.models.find((m) => m.id === id); }

  create(input: { name: string; path: string; source?: 'imported' | 'builtin'; note?: string }): { ok: boolean; model?: Live2DModel; error?: string } {
    const name = String(input.name || '').trim();
    if (!name) return { ok: false, error: '请先给形象起个名字' };
    if (name.length > 24) return { ok: false, error: '形象名最多 24 个字' };
    if (this.data.models.some((m) => m.name === name)) return { ok: false, error: '已经有同名形象了，换一个名字' };
    const model: Live2DModel = {
      id: 'l2d-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
      name,
      source: input.source === 'builtin' ? 'builtin' : 'imported',
      path: String(input.path || ''),
      visible: true,
      createdAt: new Date().toISOString(),
      note: input.note ? String(input.note).slice(0, 200) : undefined,
    };
    this.data.models.push(model);
    this.save();
    return { ok: true, model };
  }

  update(id: string, patch: { name?: string; visible?: boolean; note?: string }): { ok: boolean; model?: Live2DModel; error?: string } {
    const m = this.get(id);
    if (!m) return { ok: false, error: '形象不存在' };
    if (patch.name !== undefined) {
      const name = String(patch.name).trim();
      if (!name) return { ok: false, error: '形象名不能为空' };
      if (this.data.models.some((x) => x.name === name && x.id !== id)) return { ok: false, error: '已经有同名形象了' };
      m.name = name.slice(0, 24);
    }
    if (patch.visible !== undefined) m.visible = !!patch.visible;
    if (patch.note !== undefined) m.note = String(patch.note).slice(0, 200);
    this.save();
    return { ok: true, model: m };
  }

  remove(id: string): { ok: boolean; error?: string } {
    const i = this.data.models.findIndex((m) => m.id === id);
    if (i < 0) return { ok: false, error: '形象不存在' };
    this.data.models.splice(i, 1);
    this.save();
    return { ok: true };
  }
}
