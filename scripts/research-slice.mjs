/** Local, offline Bambu Studio experiment slicing. Never sends jobs to a printer.
 * Usage: node scripts/research-slice.mjs --assemble manifest.json --out output-directory
 * The assembly manifest uses Bambu's versioned CLI schema, with STL/OBJ paths.
 * Keep private models, manifests, and outputs under ignored test-results/.
 */
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';

export const defaultOptions = {
  binary: '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio',
  profileRoot: '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL',
  machine: 'Bambu Lab A1 0.2 nozzle',
  process: '0.06mm High Quality @BBL A1 0.2 nozzle',
  filament: 'Bambu PLA Matte @BBL A1 0.2 nozzle',
  bed: 'Textured PEI Plate',
};

async function filesIn(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await filesIn(filename));
    else if (entry.name.endsWith('.json')) result.push(filename);
  }
  return result;
}

/** Resolve inheritance in one installed preset family, retaining provenance. */
export async function resolvePreset(profileRoot, family, name) {
  const index = new Map();
  for (const filename of await filesIn(path.join(profileRoot, family))) {
    const bytes = await readFile(filename);
    const data = JSON.parse(bytes.toString('utf8'));
    if (data.name) index.set(data.name, { data, filename, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const lineage = [];
  function resolve(current, seen = new Set()) {
    if (seen.has(current)) throw new Error(`Preset inheritance cycle: ${current}`);
    const preset = index.get(current);
    if (!preset) throw new Error(`Missing ${family} preset: ${current}`);
    seen.add(current);
    const base = preset.data.inherits ? resolve(preset.data.inherits, seen) : {};
    lineage.push({ name: current, path: preset.filename, sha256: preset.sha256 });
    return { ...base, ...preset.data };
  }
  const settings = resolve(name);
  // The CLI receives a complete flattened preset rather than looking up parents.
  settings.inherits = '';
  return { settings, lineage };
}

export async function prepareSlicerPresets(directory, supplied = {}) {
  const options = { ...defaultOptions, ...supplied };
  await mkdir(directory, { recursive: true });
  const presets = {};
  for (const family of ['machine', 'process', 'filament']) {
    const resolved = await resolvePreset(options.profileRoot, family, options[family]);
    if (family === 'process') Object.assign(resolved.settings, {
      enable_support: '0', curr_bed_type: options.bed, ...supplied.processOverrides,
    });
    else Object.assign(resolved.settings, supplied[`${family}Overrides`]);
    presets[family] = { ...resolved, path: path.join(directory, `${family}.json`) };
    await writeFile(presets[family].path, JSON.stringify(resolved.settings, null, 2) + '\n');
  }
  await writeFile(path.join(directory, 'preset-provenance.json'), JSON.stringify({ options, presets }, null, 2) + '\n');
  return presets;
}

export async function sliceAssembly(assemblyPath, outputDirectory, supplied = {}) {
  const options = { ...defaultOptions, ...supplied };
  const assembly = JSON.parse(await readFile(assemblyPath, 'utf8'));
  for (const plate of assembly.plates ?? []) {
    if (plate.assemble_params) throw new Error('Bambu requires assembled_params (with d); assemble_params is silently ignored.');
  }
  const directory = path.resolve(outputDirectory);
  const presets = await prepareSlicerPresets(path.join(directory, 'presets'), options);
  const projectPath = path.join(directory, 'sliced.3mf');
  const args = [
    '--debug', '2', '--load-settings', `${presets.machine.path};${presets.process.path}`,
    '--load-filaments', presets.filament.path, '--load-assemble-list', path.resolve(assemblyPath),
    // Bambu prepends --outputdir even when --export-3mf contains an absolute path.
    '--arrange', '0', '--orient', '0', '--slice', '0', '--export-3mf', path.basename(projectPath),
    '--export-settings', path.join(directory, 'effective-settings.json'), '--outputdir', directory,
  ];
  await writeFile(path.join(directory, 'command.json'), JSON.stringify({ binary: options.binary, args }, null, 2) + '\n');
  const started = performance.now();
  const log = createWriteStream(path.join(directory, 'slice.log'));
  const outcome = await new Promise((resolve, reject) => {
    const child = spawn(options.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
    child.on('error', reject);
    child.on('close', (code, signal) => { resolve({ code, signal }); });
  });
  await new Promise(resolve => log.end(resolve));
  const result = { ...outcome, seconds: (performance.now() - started) / 1000, projectPath, gcode: [] };
  const logText = await readFile(path.join(directory, 'slice.log'), 'utf8');
  result.cliVersion = logText.match(/Current BambuStudio Version ([\d.]+)/)?.[1] ?? null;
  result.warnings = logText.split('\n').filter(line => /\[(?:warning|error)\]/.test(line));
  if (outcome.code === 0) {
    const project = await readFile(projectPath);
    result.sha256 = createHash('sha256').update(project).digest('hex');
    result.bytes = project.length;
    const archive = unzipSync(project);
    for (const [name, bytes] of Object.entries(archive)) {
      if (!name.endsWith('.gcode')) continue;
      const destination = path.join(directory, path.basename(name));
      await writeFile(destination, bytes);
      const text = strFromU8(bytes);
      result.gcode.push({ path: destination, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length,
        header: text.split('\n').filter(line => /^; (?:total estimated time|model printing time|total filament|layer_count|initial_layer_print_height|layer_height)/.test(line)).slice(0, 20) });
    }
    for (const name of ['Metadata/model_settings.config', 'Metadata/slice_info.config', 'Metadata/project_settings.config']) {
      if (archive[name]) await writeFile(path.join(directory, path.basename(name)), archive[name]);
    }
    const xml = new DOMParser().parseFromString(strFromU8(archive['Metadata/model_settings.config']), 'application/xml');
    result.objectSettings = Array.from(xml.getElementsByTagName('object')).map(object => ({ id: object.getAttribute('id'),
      settings: Object.fromEntries(Array.from(object.childNodes).filter(node => node.nodeName === 'metadata' && node.hasAttribute('key'))
        .map(node => [node.getAttribute('key'), node.getAttribute('value')])) }));
    const sliceXml = new DOMParser().parseFromString(strFromU8(archive['Metadata/slice_info.config']), 'application/xml');
    const labelNames = new Map(Array.from(sliceXml.getElementsByTagName('object'))
      .map(object => [object.getAttribute('identify_id'), object.getAttribute('name')]));
    result.supportRoleMarkers = {};
    for (const entry of result.gcode) {
      let objectName;
      for (const line of (await readFile(entry.path, 'utf8')).split('\n')) {
        const object = line.match(/^; OBJECT_ID:\s*(\d+)/);
        if (object) objectName = labelNames.get(object[1]);
        if (objectName && /^; FEATURE: Support(?: interface)?\s*$/.test(line)) {
          result.supportRoleMarkers[objectName] = (result.supportRoleMarkers[objectName] ?? 0) + 1;
        }
      }
    }
    for (const plate of assembly.plates) {
      for (const group of plate.assembled_params ?? []) {
        const actual = result.objectSettings.find(object => object.settings.name === `assemble_${group.assemble_index}`)?.settings;
        for (const [key, expected] of Object.entries(group.print_params ?? {})) {
          const sameNumber = actual?.[key] !== undefined && String(expected).trim() !== '' && actual[key].trim() !== ''
            && Number.isFinite(Number(expected)) && Number(actual[key]) === Number(expected);
          if (actual?.[key] !== expected && !sameNumber) throw new Error(`Exported assembly ${group.assemble_index}: ${key}=${actual?.[key]}, expected ${expected}.`);
        }
        if (group.print_params?.enable_support === '1' && !result.supportRoleMarkers[`assemble_${group.assemble_index}`]) {
          throw new Error(`Native support control ${group.assemble_index} has no Support feature markers in G-code.`);
        }
        if (group.print_params?.enable_support === '0' && result.supportRoleMarkers[`assemble_${group.assemble_index}`]) {
          throw new Error(`External support assembly ${group.assemble_index} unexpectedly has native support markers.`);
        }
      }
    }
  }
  await writeFile(path.join(directory, 'slice-result.json'), JSON.stringify(result, null, 2) + '\n');
  if (outcome.code !== 0) throw new Error(`Bambu Studio failed (${outcome.code ?? outcome.signal}); inspect ${path.join(directory, 'slice.log')}`);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) options[args[i].replace(/^--/, '')] = args[i + 1];
  if (!options.assemble || !options.out) throw new Error('Required: --assemble manifest.json --out output-directory');
  console.log(JSON.stringify(await sliceAssembly(options.assemble, options.out, {
    ...(options.binary && { binary: options.binary }), ...(options['profile-root'] && { profileRoot: options['profile-root'] }),
  }), null, 2));
}
