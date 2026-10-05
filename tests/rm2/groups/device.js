// Device group: the real ARM build, the production first-run executable, and
// the production installer/uninstaller run against a sandbox directory that
// stands in for the tablet (ssh/scp/XOVI scripts are the doubles). Nothing here
// touches a physical reMarkable.
module.exports = (L) => {
  const { assert, fs, path } = L;
  const sha = (file) => L.crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  function tree(root, skip = () => false) {
    const out = {};
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const rel = path.relative(root, p); if (skip(rel)) continue; if (e.isDirectory()) { out[rel + '/'] = 'dir'; walk(p); } else out[rel] = sha(p); } };
    walk(root);
    return out;
  }

  // A sandbox tablet: filesystem root, fake dependency artifacts with their own manifest, ssh/scp doubles.
  function sandbox({ version = '3.28.0.162', model = 'reMarkable 2.0', existingXovi = false, startFails = false } = {}) {
    const top = L.tmp('tablet');
    const root = path.join(top, 'root');
    const w = (rel, text, mode) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, mode ? { mode } : undefined); };
    w('sys/devices/soc0/machine', model + '\n');
    w('etc/os-release', `IMG_VERSION="${version}"\n`);
    w('usr/share/remarkable/update.conf', '[General]\nSERVER=https://updates.example\n');
    w('etc/systemd/system/keep.txt', 'stock unit files');
    w('home/root/.config/remarkable/xochitl.conf', '[General]\nPasscode=1234\n');
    w('home/root/.local/share/remarkable/xochitl/doc-1.pdf', 'USER DOCUMENT ONE');
    w('home/root/.local/share/remarkable/xochitl/doc-1.metadata', '{"visibleName":"Notes"}');
    w('home/root/notes.txt', 'unrelated');
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    // Fake dependency artifacts (the real ones are 10 MB of third-party binaries and are not in the repository).
    const deps = path.join(top, 'deps'); const src = path.join(top, 'src');
    const s = (rel, text, mode = 0o644) => { const f = path.join(src, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text, { mode }); };
    const state = '"${RM2_ROOT}/var/xovi-state"';
    s('xovi/xovi.so', 'XOVI-LOADER');
    s('xovi/extensions.d/qt-resource-rebuilder.so', 'QRR');
    s('xovi/inactive-extensions/webserver-remote.so', 'MUST NOT BE INSTALLED');
    s('xovi/rebuild_hashtable', '#!/bin/sh\nexit 0\n', 0o755);
    s('xovi/start', `#!/bin/sh\nmkdir -p "\${RM2_ROOT}/var"\n${startFails ? 'echo "xochitl failed to restart" >&2; exit 1' : `echo started >> ${state}`}\n`, 0o755);
    s('xovi/stock', `#!/bin/sh\nmkdir -p "\${RM2_ROOT}/var"\necho stock >> ${state}\n`, 0o755);
    s('appload.so', 'APPLOAD-EXTENSION');
    fs.mkdirSync(deps);
    L.spawnSync('tar', ['czf', path.join(deps, 'xovi-arm32.tar.gz'), '-C', src, 'xovi']);
    L.spawnSync('tar', ['czf', path.join(deps, 'appload-arm32.tar.gz'), '-C', src, 'appload.so']);
    const manifest = path.join(top, 'deps.json');
    const writeManifest = () => fs.writeFileSync(manifest, JSON.stringify({ artifacts: [{ id: 'xovi-bundle', file: 'xovi-arm32.tar.gz', sha256: sha(path.join(deps, 'xovi-arm32.tar.gz')) }, { id: 'appload', file: 'appload-arm32.tar.gz', sha256: sha(path.join(deps, 'appload-arm32.tar.gz')) }] }));
    writeManifest();
    if (existingXovi) { // someone already runs XOVI with their own extension and app
      w('home/root/xovi/xovi.so', 'XOVI-LOADER');
      w('home/root/xovi/extensions.d/qt-resource-rebuilder.so', 'QRR');
      w('home/root/xovi/extensions.d/user-extension.so', 'USER EXT');
      w('home/root/xovi/exthome/appload/other-app/external.manifest.json', '{"name":"Other"}');
      w('home/root/xovi/exthome/qt-resource-rebuilder/hashtab', 'USER HASHTAB');
      w('home/root/xovi/start', '#!/bin/sh\nmkdir -p "${RM2_ROOT}/var"\n' + `echo started >> ${state}\n`, 0o755);
      w('home/root/xovi/stock', '#!/bin/sh\nmkdir -p "${RM2_ROOT}/var"\n' + `echo stock >> ${state}\n`, 0o755);
      w('home/root/xovi/rebuild_hashtable', '#!/bin/sh\nexit 0\n', 0o755);
    }
    const home = path.join(top, 'machome');
    const reportDir = path.join(top, 'reports'); fs.mkdirSync(reportDir);
    // The ssh/scp doubles are copied and made executable here (like the tmux double): the
    // controller installs oracle files without the executable bit.
    const doubles = path.join(top, 'doubles'); fs.mkdirSync(doubles);
    for (const f of ['fake-ssh', 'fake-scp']) { fs.copyFileSync(path.join(L.candidate, 'tests/rm2', f), path.join(doubles, f)); fs.chmodSync(path.join(doubles, f), 0o755); }
    const env = { ...process.env, MATRIX_HOME: home, RM2_SSH: path.join(doubles, 'fake-ssh'), RM2_SCP: path.join(doubles, 'fake-scp'), FAKE_DEVICE_ROOT: root, FAKE_DEVICE_BIN: path.join(top, 'bin'), RM2_DEPS_MANIFEST: manifest, MATRIX_RM2_DEPS: deps };
    fs.mkdirSync(path.join(top, 'bin'));
    const install = (cmd, extra = [], more = {}) => L.spawnSync(process.execPath, [path.join(L.candidate, 'scripts', 'rm2-install'), cmd, '--host', 'tablet.sandbox', '--binary', L.hostBin(), '--report-dir', reportDir, ...(cmd === 'install' ? ['--url', 'https://192.168.68.63:7779'] : []), ...extra], { encoding: 'utf8', env: { ...env, ...more } });
    const argv = (cmd, extra = []) => [path.join(L.candidate, 'scripts', 'rm2-install'), cmd, '--host', 'tablet.sandbox', '--binary', L.hostBin(), '--report-dir', reportDir, ...(cmd === 'install' ? ['--url', 'https://192.168.68.63:7779'] : []), ...extra];
    return { argv, top, root, deps, home, env, install, reportDir, writeManifest, manifest, read: (rel) => fs.readFileSync(path.join(root, rel), 'utf8'), exists: (rel) => fs.existsSync(path.join(root, rel)), xoviState: () => (fs.existsSync(path.join(root, 'var/xovi-state')) ? fs.readFileSync(path.join(root, 'var/xovi-state'), 'utf8').trim().split('\n') : []) };
  }
  // L3-1: the installer's temporary files on the tablet are its own. Whatever already exists under
  // /tmp, including a /tmp/matrix-rm2 it used to claim, is never adopted, followed or deleted.
  async function stagingOwnership(t) {
    const meta = (root) => { const out = {}; const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); const st = fs.lstatSync(p); out[path.relative(root, p)] = [st.mode, st.ino, st.size, st.mtimeMs, e.isSymbolicLink() ? fs.readlinkSync(p) : e.isFile() ? sha(p) : 'dir']; if (e.isDirectory()) walk(p); } }; walk(root); const st = fs.lstatSync(root); out['.'] = [st.mode, st.ino, st.mtimeMs]; return out; };
    const stages = (sb) => fs.readdirSync(path.join(sb.root, 'tmp')).filter((n) => /^matrix-rm2\./.test(n));
    const sshLog = (sb) => (fs.existsSync(path.join(sb.top, 'ssh.log')) ? fs.readFileSync(path.join(sb.top, 'ssh.log'), 'utf8').split('\n').filter(Boolean) : []);
    const removed = (sb) => sshLog(sb).filter((l) => /\brm -rf\b/.test(l));
    const seed = (sb) => {
      const d = path.join(sb.root, 'tmp/matrix-rm2');
      fs.mkdirSync(path.join(d, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(d, 'sentinel.txt'), 'SOMEONE ELSE\'S DATA', { mode: 0o640 });
      fs.writeFileSync(path.join(d, 'sub/device.sh'), '#!/bin/sh\necho MUST-NOT-RUN > "$RM2_ROOT/tmp/ran"\n', { mode: 0o755 });
      fs.writeFileSync(path.join(sb.root, 'tmp/matrix-rm2-stage.tar'), 'NOT OURS');
      for (const f of ['sub/device.sh', 'sub', 'sentinel.txt', '.']) fs.utimesSync(path.join(d, f), 1600000000, 1600000000);
      return d;
    };
    // (1) An unrelated /tmp/matrix-rm2 survives every command, contents and metadata, and nothing is left behind.
    let sb = sandbox();
    let other = seed(sb);
    let before = meta(other);
    const ran = [];
    for (const cmd of ['check', 'install', 'activate', 'stock', 'uninstall']) {
      const r = sb.install(cmd);
      ran.push(`${cmd}=${r.status}`);
      assert.ok(cmd === 'check' ? [0, 7].includes(r.status) : r.status === 0, `${cmd} ran (exit ${r.status}): ${r.stderr}`);
      assert.deepEqual(meta(other), before, `${cmd} left the unrelated /tmp/matrix-rm2 exactly as it was (contents, modes, inodes, times)`);
      assert.equal(fs.readFileSync(path.join(sb.root, 'tmp/matrix-rm2-stage.tar'), 'utf8'), 'NOT OURS', `${cmd} left the unrelated tar file alone`);
      assert.deepEqual(stages(sb), [], `${cmd} removed its own staging directory`);
    }
    assert.ok(!fs.existsSync(path.join(sb.root, 'tmp/ran')), 'the unrelated device.sh was never executed');
    const rm = removed(sb);
    assert.ok(rm.length >= 5 && rm.every((l) => /^rm -rf "\$\{RM2_ROOT:-\}\/tmp\/matrix-rm2\.[A-Za-z0-9]{6}"$/.test(l)), `every delete names exactly one directory the tablet created for that run: ${JSON.stringify(rm)}`);
    assert.equal(new Set(rm).size, rm.length, 'each run had its own directory');
    // (2) /tmp/matrix-rm2 is a symlink to someone's directory: not followed, not replaced.
    sb = sandbox();
    const victim = path.join(sb.root, 'home/root/victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'keep.txt'), 'KEEP');
    fs.symlinkSync(victim, path.join(sb.root, 'tmp/matrix-rm2'));
    before = meta(victim);
    for (const cmd of ['check', 'install']) {
      const r = sb.install(cmd);
      assert.ok([0, 7].includes(r.status), `${cmd} with a symlink present (exit ${r.status}): ${r.stderr}`);
      assert.deepEqual(meta(victim), before, `${cmd} did not write into or delete the symlink's target`);
      assert.equal(fs.readlinkSync(path.join(sb.root, 'tmp/matrix-rm2')), victim, 'the symlink itself is untouched');
      assert.deepEqual(stages(sb), []);
    }
    // (3) The tablet cannot create a staging directory, or answers with a path that is not a new one: stop, delete nothing.
    for (const [what, script] of [['fails', '#!/bin/sh\necho "mktemp: No space left on device" >&2\nexit 1\n'], ['answers with an existing path', '#!/bin/sh\necho "$RM2_ROOT/tmp/matrix-rm2"\n']]) {
      sb = sandbox(); other = seed(sb); before = meta(other);
      fs.writeFileSync(path.join(sb.top, 'bin/mktemp'), script, { mode: 0o755 });
      const r = sb.install('check');
      assert.notEqual(r.status, 0, `check stops when mktemp ${what}`);
      assert.match(r.stderr, /staging directory|No space left/, 'the reason is stated');
      assert.deepEqual(removed(sb), [], `no delete was issued when mktemp ${what}`);
      assert.deepEqual([meta(other), stages(sb)], [before, []], 'the unrelated directory is untouched and nothing was created');
      assert.ok(!sshLog(sb).some((l) => /device\.sh/.test(l)), 'no staged script was run');
    }
    // (4) Failure after staging (the transfer breaks): only the directory that was created is removed.
    sb = sandbox(); other = seed(sb); before = meta(other);
    let r = sb.install('check', [], { FAKE_SCP_MODE: 'fail' });
    assert.notEqual(r.status, 0);
    assert.deepEqual([meta(other), stages(sb), removed(sb).length], [before, [], 1], 'after a failed transfer the run removed its one directory and nothing else');
    // (5) Two installers at once work in different directories and each removes only its own.
    sb = sandbox(); other = seed(sb); before = meta(other);
    const both = await Promise.all([0, 1].map(() => new Promise((resolve) => { const p = L.spawn(process.execPath, sb.argv('check'), { env: sb.env, stdio: 'ignore' }); L.registerProc(p); p.on('exit', resolve); })));
    assert.ok(both.every((c) => [0, 7].includes(c)), `both concurrent checks completed (${both})`);
    const two = removed(sb);
    assert.deepEqual([two.length, new Set(two).size, stages(sb), meta(other)], [2, 2, [], before], 'two distinct staging directories, both removed, the unrelated one untouched');
    t.note(`staging ownership: unrelated /tmp/matrix-rm2 (dir and symlink) unchanged in contents+metadata across ${ran.join(' ')}; mktemp failure / bogus answer → stop with 0 deletes; failed transfer → only its own directory removed; 2 concurrent checks → 2 distinct directories`);
  }

  const notTmp = (rel) => rel === 'tmp' || rel.startsWith('tmp/') || rel === 'var' || rel.startsWith('var/');

  return {
    async arm_package(t) {
      const build = (target) => { const r = L.spawnSync(path.join(L.candidate, 'scripts/rm2-build'), [target], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim().split('\n').pop(); };
      const arm = build('arm');
      const b = fs.readFileSync(arm);
      assert.deepEqual([b[0], b.subarray(1, 4).toString(), b[4], b[5]], [0x7f, 'ELF', 1, 1], 'ELF, 32-bit, little-endian');
      assert.equal(b.readUInt16LE(18), 40, 'e_machine = ARM');
      assert.equal(b.readUInt16LE(16), 2, 'an executable');
      assert.equal(b.readUInt32LE(36) >>> 24, 5, 'ARM EABI version 5');
      // Program headers: no interpreter and no dynamic section → statically linked, no library dependencies on the tablet.
      const phoff = b.readUInt32LE(28); const phentsize = b.readUInt16LE(42); const phnum = b.readUInt16LE(44);
      const types = Array.from({ length: phnum }, (_, i) => b.readUInt32LE(phoff + i * phentsize));
      assert.ok(!types.includes(3) && !types.includes(2), `no PT_INTERP/PT_DYNAMIC (types ${types})`);
      const first = sha(arm);
      fs.rmSync(arm);
      assert.equal(sha(build('arm')), first, 'the ARM build is reproducible (identical SHA-256 on rebuild)');
      const text = b.toString('latin1');
      for (const needle of ['/tmp/qtfb.sock', '/dev/shm/qtfb_', 'QTFB_KEY']) assert.ok(text.includes(needle), `the device display link (${needle}) is compiled into the ARM binary`);
      // The host build is the same program (same package, same renderer/transport/backend code).
      const host = build('host');
      const ver = L.spawnSync(host, ['version'], { encoding: 'utf8' }).stdout.trim();
      assert.match(ver, /^matrix-rm2 \d+\.\d+\.\d+ darwin|^matrix-rm2 \d+\.\d+\.\d+ linux/);
      assert.ok(text.includes(`matrix-rm2 %s %s/%s protocol`) || text.includes(fs.readFileSync(path.join(L.candidate, 'rm2/VERSION'), 'utf8').trim()), 'same version string source');
      const list = L.spawnSync('go', ['list', '-deps', './cmd/matrix-rm2'], { cwd: path.join(L.candidate, 'rm2'), encoding: 'utf8', env: { ...process.env, GOFLAGS: '-mod=mod', GOPROXY: 'off', GOOS: 'linux', GOARCH: 'arm' } }).stdout.split('\n');
      for (const pkg of ['matrixrm2/ui', 'matrixrm2/wire', 'matrixrm2/netc', 'matrixrm2/firstrun', 'matrixrm2/font']) assert.ok(list.includes(pkg), `${pkg} is part of the ARM program`);
      assert.deepEqual(list.filter((p) => p.split('/')[0].includes('.')), [], 'no third-party module dependencies (only the standard library)');
      // Package manifest and pinned dependencies.
      const man = JSON.parse(fs.readFileSync(path.join(L.candidate, 'rm2/app/external.manifest.json'), 'utf8'));
      assert.deepEqual([man.application, man.qtfb, man.disablesWindowedMode], ['launch.sh', true, true]);
      const deps = JSON.parse(fs.readFileSync(path.join(L.candidate, 'rm2/DEPENDENCIES.json'), 'utf8'));
      for (const a of deps.artifacts) { assert.match(a.sha256, /^[0-9a-f]{64}$/); assert.match(a.source, /commit [0-9a-f]{40}/); assert.match(a.url, /\/releases\/download\/[^/]+\//, 'a pinned release URL, never "latest"'); assert.ok(a.license); }
      assert.equal(sha(path.join(L.candidate, 'rm2/font/unifont-16.0.04.hex.gz')), deps.embedded[0].sha256, 'embedded font matches its pinned checksum');
      t.note(`ARM binary ${b.length} bytes: ELF32 LE ARM EABI5, static (no PT_INTERP/PT_DYNAMIC), reproducible sha ${first.slice(0, 12)}; device QTFB link present; 5 shared packages, 0 third-party modules; 2 pinned artifacts with commits`);
    },

    async firmware_preflight(t) {
      const bin = L.hostBin();
      const inspect = (opts) => { const root = L.fixtureRoot(opts); const r = L.spawnSync(bin, ['firstrun', '--root', root, '--json'], { encoding: 'utf8' }); return { code: r.status, rep: JSON.parse(r.stdout), root, text: L.spawnSync(bin, ['firstrun', '--root', root], { encoding: 'utf8' }).stdout }; };
      const table = [
        ['supported 3.28 (os-release)', {}, 0, /supported/],
        ['supported 3.28 (update.conf)', { versionFile: 'update.conf', version: '3.28.1.7' }, 0, /supported/],
        ['future 3.29', { version: '3.29.0.48' }, 4, /software version 3\.29\.0\.48 is not supported \(supported: 3\.28\)/],
        ['future 4.0', { version: '4.0.0.1' }, 4, /4\.0\.0\.1 is not supported/],
        ['old 3.20', { version: '3.20.0.92' }, 4, /3\.20\.0\.92 is not supported/],
        ['malformed', { version: 'three.point.oh' }, 6, /malformed software version "three\.point\.oh"/],
        ['missing version', { version: null }, 6, /could not be read/],
        ['wrong model', { model: 'reMarkable Ferrari' }, 5, /unsupported hardware model "reMarkable Ferrari"/],
        ['missing backend', { backend: false }, 7, /display backend incomplete/],
        ['missing hashtable', { hashtab: false }, 7, /hashtable for this software version has not been built/],
      ];
      const seen = [];
      for (const [name, opts, code, reason] of table) {
        const r = inspect(opts);
        assert.equal(r.code, code, `${name}: exit code`);
        assert.equal(r.rep.supported, code === 0, name);
        assert.match(r.rep.reason, reason, name);
        if (opts.version && opts.version !== null) { assert.equal(r.rep.version, opts.version, `${name}: exact detected version in the report`); assert.ok(r.text.includes(`Software version: ${opts.version}`), `${name}: exact version in the human report`); }
        seen.push(`${name}=${code}`);
      }
      // Unsupported: the client makes no display call at all.
      const unsupported = L.fixtureRoot({ version: '3.29.0.48' });
      const st = L.tmp('state');
      const cfg = path.join(st, 'c.json'); fs.writeFileSync(cfg, '{}');
      let r = L.spawnSync(bin, ['run', '--backend', 'capture', '--root', unsupported, '--state-dir', st, '--config', cfg], { encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 4);
      assert.equal(r.stdout, '', 'no screen was drawn and no refresh was sent for an unsupported version');
      assert.match(r.stderr, /NOT SUPPORTED.*3\.29\.0\.48/s);
      assert.equal(JSON.parse(fs.readFileSync(path.join(st, 'firstrun-report.json'), 'utf8')).version, '3.29.0.48', 'the report file for Mac diagnostics carries the exact version');
      // Supported version, display probe fails.
      const okRoot = L.fixtureRoot();
      r = L.spawnSync(bin, ['run', '--backend', 'capture', '--root', okRoot, '--state-dir', L.tmp('s2'), '--config', cfg], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MATRIX_RM2_CAPTURE_FAIL_AT: '1' } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /display probe failed/);
      // Files are all present, but the display backend answers the handshake with something this client
      // was not built for (another framebuffer geometry, or not an initialise response at all).
      const le = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
      const initResp = (type, key, size) => Buffer.concat([Buffer.from([type, 0, 0, 0]), le(key), le(size), Buffer.alloc(12)]).toString('hex');
      for (const [name, fixture, want] of [
        ['other framebuffer geometry', initResp(0, 7, 1620 * 2160 * 2), /incompatible display backend: framebuffer is 6998400 bytes, this client needs 5256576/],
        ['not an initialise response', initResp(3, 0, 0), /incompatible display backend: expected an initialise response \(type 0\), got message type 3/],
      ]) {
        const sdir = L.tmp('sx');
        r = L.spawnSync(bin, ['run', '--backend', 'capture', '--root', okRoot, '--state-dir', sdir, '--config', cfg], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MATRIX_RM2_CAPTURE_INIT: fixture } });
        assert.equal(r.status, 8, `${name}: refused with the display-probe exit code`);
        assert.equal(r.stdout, '', `${name}: nothing was drawn and no refresh was sent`);
        assert.match(r.stderr, want, name);
        const repx = JSON.parse(fs.readFileSync(path.join(sdir, 'firstrun-report.json'), 'utf8'));
        assert.deepEqual([repx.supported, repx.code], [false, 8], `${name}: recorded for Mac diagnostics`);
      }
      const valid = L.spawnSync(bin, ['run', '--backend', 'capture', '--root', okRoot, '--state-dir', L.tmp('sv'), '--config', cfg, '--firstrun-touch-seconds', '1'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, MATRIX_RM2_CAPTURE_INIT: initResp(0, 7, 1404 * 1872 * 2) } });
      assert.ok(valid.stdout.includes('"firstrun"'), 'the pinned backend\'s own handshake answer is accepted and the first-run screen is drawn');
      // Supported version, display works, touch probe fails (no tap).
      const s3 = L.tmp('s3');
      r = L.spawnSync(bin, ['run', '--backend', 'capture', '--root', okRoot, '--state-dir', s3, '--config', cfg, '--firstrun-touch-seconds', '1'], { encoding: 'utf8', timeout: 20000 });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /touch probe failed/);
      const rep3 = JSON.parse(fs.readFileSync(path.join(s3, 'firstrun-report.json'), 'utf8'));
      assert.deepEqual([rep3.supported, rep3.code], [false, 9]);
      assert.ok(!fs.readdirSync(s3).some((f) => f.startsWith('firstrun-ok-')), 'no success marker after a failed probe');
      // Supported and working: the on-device screen shows the exact version and every check.
      const tm = L.fakeTmux(); tm.setPanes([tm.pane({})]);
      const srv = await L.startServer({ env: tm.env, tls: true });
      const client = await L.startClient({ endpoints: [srv.endpoint('home-lan')], token: srv.token('device'), root: okRoot });
      const screen = client.firstrun.screen.join('\n');
      for (const want of ['SUPPORTED', 'Software version: 3.28.0.162', 'Device model: reMarkable 2.0', '[PASS] display probe', '[PASS] route home-lan: authenticated snapshot received', 'TOUCH CHECK: tap anywhere']) assert.ok(screen.includes(want), `first-run screen shows: ${want}`);
      const repOk = JSON.parse(fs.readFileSync(path.join(client.dir, 'state', 'firstrun-report.json'), 'utf8'));
      assert.ok(repOk.checks.some((c) => c.name === 'touch probe' && c.ok), 'touch probe recorded after the tap');
      t.note(`first-run matrix: ${seen.join(', ')}; unsupported → exit 4 with 0 display output; incompatible backend handshake (2 fixtures) → exit 8 with 0 display output; display probe failure and touch probe failure → non-zero with report; supported → on-screen report with version, display, route and touch checks`);
    },

    async install_restore(t) {
      for (const existingXovi of [false, true]) {
        const sb = sandbox({ existingXovi });
        const before = tree(sb.root, notTmp);
        let r = sb.install('install');
        assert.equal(r.status, 0, `install failed: ${r.stderr}${r.stdout}`);
        assert.match(r.stdout, /Tablet software version: 3\.28\.0\.162/, 'the Mac shows the exact detected version');
        const app = 'home/root/xovi/exthome/appload/matrix-rm2';
        for (const f of ['matrix-rm2', 'launch.sh', 'external.manifest.json', 'icon.png']) assert.ok(sb.exists(`${app}/${f}`), `${f} installed`);
        assert.equal(sha(path.join(sb.root, app, 'matrix-rm2')), sha(L.hostBin()), 'the client binary arrived intact');
        assert.equal(sb.read('home/root/xovi/extensions.d/appload.so'), 'APPLOAD-EXTENSION');
        assert.ok(!sb.exists('home/root/xovi/inactive-extensions/webserver-remote.so'), 'optional third-party extensions are not installed');
        const cfg = JSON.parse(sb.read('home/root/.config/matrix-rm2/config.json'));
        assert.equal(cfg.endpoints[0].url, 'https://192.168.68.63:7779');
        assert.match(cfg.endpoints[0].pin_sha256, /^[0-9a-f]{64}$/);
        assert.equal(fs.statSync(path.join(sb.root, 'home/root/.config/matrix-rm2/config.json')).mode & 0o777, 0o600);
        const auth = L.eink(sb.home);
        assert.equal(auth.verify(`Bearer ${cfg.token}`).scope, 'device', 'the tablet holds a device-scope capability only');
        assert.ok(!/BEGIN (OPENSSH|RSA|EC) PRIVATE KEY/.test(sb.read('home/root/.config/matrix-rm2/config.json')), 'no private key or Mac login credential on the tablet');
        const owned = sb.read('home/root/.local/share/matrix-rm2/owned.txt').trim().split('\n');
        assert.ok(owned.includes('/home/root/xovi/exthome/appload/matrix-rm2/matrix-rm2'));
        assert.equal(owned.includes('/home/root/xovi/xovi.so'), !existingXovi, 'a pre-existing XOVI is not claimed as ours');
        // The hashtable is a human step on a fresh tablet; with it in place the check passes.
        if (!existingXovi) {
          r = sb.install('check');
          assert.equal(r.status, 7, 'before the hashtable is built the check says so');
          fs.mkdirSync(path.join(sb.root, 'home/root/xovi/exthome/qt-resource-rebuilder'), { recursive: true });
          fs.writeFileSync(path.join(sb.root, 'home/root/xovi/exthome/qt-resource-rebuilder/hashtab'), 'BUILT BY THE USER STEP');
        }
        r = sb.install('check');
        assert.equal(r.status, 0, `check after install: ${r.stdout}${r.stderr}`);
        assert.match(r.stdout, /\[PASS\] display backend/);
        // Activate, then return to stock.
        r = sb.install('activate');
        assert.equal(r.status, 0, `activate: ${r.stderr}${r.stdout}`);
        assert.deepEqual(sb.xoviState(), ['started']);
        // The installed client launches from the installed files and exits cleanly on Exit and on the stock gesture.
        const tm = L.fakeTmux(); tm.setPanes([tm.pane({})]);
        const srv = await L.startServer({ env: tm.env, tls: true });
        const cfgFile = path.join(sb.top, 'client.json');
        fs.writeFileSync(cfgFile, JSON.stringify({ endpoints: [srv.endpoint('home-lan')], token: srv.token('device') }));
        const launch = (extra) => L.spawn(path.join(sb.root, app, 'matrix-rm2'), ['run', '--backend', 'capture', '--config', cfgFile, '--root', sb.root, '--state-dir', path.join(sb.top, `st-${extra}`)], { stdio: ['pipe', 'pipe', 'pipe'] });
        for (const how of ['exit-button', 'stock-gesture']) {
          const p = launch(how); L.registerProc(p);
          let out = ''; p.stdout.on('data', (d) => { out += d; });
          await L.until(() => out.includes('"firstrun"'), 15000, 'installed client first-run screen');
          const send = (o) => p.stdin.write(JSON.stringify(o) + '\n');
          send({ touch: [0x10, 0, 700, 900] }); send({ touch: [0x11, 0, 700, 900] });
          await L.until(() => { send({ dump: true }); return /"Status":"fresh"/.test(out); }, 15000, 'installed client connected');
          if (how === 'exit-button') { send({ touch: [0x10, 0, 1312, 31] }); send({ touch: [0x11, 0, 1312, 31] }); } else p.kill('SIGTERM'); // AppLoad's close gesture ends the process
          const code = await new Promise((ok) => p.once('exit', (c) => ok(c)));
          assert.equal(code, 0, `${how}: the client exits cleanly`);
          // Observed at the display link: the client sent MESSAGE_TERMINATE, which is what makes AppLoad drop the
          // framebuffer and hand display and input back.
          assert.ok(/\{"released":true\}/.test(out), `${how}: the backend was released (MESSAGE_TERMINATE sent) before exit`);
        }
        // Stock restoration through the device adapter: the stock script ran on the (sandbox) tablet after activation.
        r = sb.install('stock');
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /stock interface restored/);
        assert.deepEqual(sb.xoviState(), ['started', 'stock']);
        // Repeat install: idempotent.
        r = sb.install('install');
        assert.equal(r.status, 0, `second install: ${r.stderr}`);
        // Uninstall: only owned files go; everything else is byte-identical to before the first install.
        r = sb.install('uninstall');
        assert.equal(r.status, 0, r.stderr + r.stdout);
        const hashtabOurs = (rel) => !existingXovi && (rel.startsWith('home/root/xovi') || rel === 'home/root/.local/share/remarkable' );
        const after = tree(sb.root, (rel) => notTmp(rel));
        if (!existingXovi) {
          // The user-built hashtable is not ours, so its directories stay; everything Matrix added is gone.
          const leftover = Object.keys(after).filter((k) => !(k in before));
          assert.deepEqual(leftover.sort(), ['home/root/xovi/', 'home/root/xovi/exthome/', 'home/root/xovi/exthome/qt-resource-rebuilder/', 'home/root/xovi/exthome/qt-resource-rebuilder/hashtab'], 'only the hashtable the user built remains');
          for (const k of leftover) delete after[k];
        }
        assert.deepEqual(after, before, 'documents, settings and pre-existing software are byte-identical after uninstall');
        assert.ok(hashtabOurs || true);
        r = sb.install('uninstall');
        assert.equal(r.status, 0);
        assert.match(r.stdout, /nothing installed by Matrix/);
        assert.deepEqual(tree(sb.root, notTmp), { ...after, ...(existingXovi ? {} : Object.fromEntries(['home/root/xovi/', 'home/root/xovi/exthome/', 'home/root/xovi/exthome/qt-resource-rebuilder/'].map((k) => [k, 'dir']).concat([['home/root/xovi/exthome/qt-resource-rebuilder/hashtab', sha(path.join(sb.root, 'home/root/xovi/exthome/qt-resource-rebuilder/hashtab'))]]))) }, 'a second uninstall changes nothing');
      }
      // Mac-side hook install/uninstall keeps every other hook byte-for-byte.
      const dir = L.tmp('claude');
      const settings = path.join(dir, 'settings.json');
      const original = { model: 'opus', hooks: { PostToolUse: [{ matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'node /other/lint.js' }] }], Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/other-stop' }] }] }, permissions: { allow: ['Bash(ls:*)'] } };
      fs.writeFileSync(settings, JSON.stringify(original, null, 2) + '\n');
      const cli = (cmd) => L.spawnSync(process.execPath, [path.join(L.candidate, 'scripts/matrix-eink'), cmd], { encoding: 'utf8', env: { ...process.env, MATRIX_HOME: path.join(dir, 'm'), CLAUDE_SETTINGS: settings } });
      assert.equal(cli('install-hook').status, 0);
      const installed = JSON.parse(fs.readFileSync(settings, 'utf8'));
      assert.equal(Object.keys(installed.hooks).length, 11, 'the evidence hook is on all 11 events');
      assert.deepEqual(installed.hooks.PostToolUse[0], original.hooks.PostToolUse[0], 'the existing hook is untouched and still first');
      const once = fs.readFileSync(settings, 'utf8');
      assert.equal(cli('install-hook').status, 0);
      assert.equal(fs.readFileSync(settings, 'utf8'), once, 'installing twice changes nothing');
      assert.equal(cli('uninstall-hook').status, 0);
      assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), original, 'uninstall restores exactly the original settings');
      assert.equal(cli('uninstall-hook').status, 0);
      await stagingOwnership(t);
      t.note('fresh tablet and tablet with existing XOVI: install → check (hashtable step) → activate → client launches and exits cleanly (Exit button, SIGTERM) → stock → reinstall → uninstall; unrelated files byte-identical; Mac hook install/uninstall idempotent and exact');
    },

    async rollback_failures(t) {
      const notes = [];
      // 1. Checksum mismatch on the Mac: nothing is sent to the tablet.
      let sb = sandbox();
      let before = tree(sb.root);
      fs.appendFileSync(path.join(sb.deps, 'appload-arm32.tar.gz'), 'tampered');
      let r = sb.install('install');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /checksum mismatch for appload-arm32\.tar\.gz: expected [0-9a-f]{64}, found [0-9a-f]{64}.*Refusing to install/s);
      assert.deepEqual(tree(sb.root), before, 'the tablet is untouched');
      assert.ok(!fs.existsSync(path.join(sb.top, 'ssh.log')), 'no connection was even made');
      notes.push('checksum mismatch → refused before any connection');
      // 2. Missing dependency: an actionable message.
      sb = sandbox(); fs.rmSync(path.join(sb.deps, 'xovi-arm32.tar.gz'));
      r = sb.install('install');
      assert.match(r.stderr, /Run scripts\/rm2-fetch-deps first/);
      // 3. Transfer interrupted.
      sb = sandbox(); before = tree(sb.root, notTmp);
      r = sb.install('install', [], { FAKE_SCP_MODE: 'truncate' });
      assert.notEqual(r.status, 0);
      assert.match(r.stderr, /remote step failed|transfer/i);
      assert.deepEqual(tree(sb.root, notTmp), before, 'an interrupted transfer installs nothing');
      r = sb.install('install', [], { FAKE_SCP_MODE: 'fail' });
      assert.match(r.stderr, /transfer failed/);
      assert.deepEqual(tree(sb.root, notTmp), before);
      notes.push('truncated and failed transfers → nothing installed');
      // 4. Dependency incompatibility: a different AppLoad is already there.
      sb = sandbox({ existingXovi: true });
      fs.writeFileSync(path.join(sb.root, 'home/root/xovi/extensions.d/appload.so'), 'SOME OTHER APPLOAD BUILD');
      before = tree(sb.root, notTmp);
      r = sb.install('install');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /dependency incompatibility: \/home\/root\/xovi\/extensions\.d\/appload\.so already exists with different contents.*left untouched/s);
      assert.match(r.stderr, /rolled back; the tablet is as it was before/);
      { const now = tree(sb.root, notTmp); const diff = [...new Set([...Object.keys(now), ...Object.keys(before)])].filter((k) => now[k] !== before[k]); assert.deepEqual(diff, [], `everything this run created was rolled back; the existing XOVI/app config survives (differences: ${diff.join(', ')})`); }
      const tokens = L.eink(sb.home).list();
      assert.ok(tokens.length === 1 && tokens[0].revoked, 'the device token issued for the failed install was revoked');
      notes.push('conflicting pre-existing AppLoad → rollback, existing setup intact, token revoked');
      // 5. Service start failure on activate: stock is restored.
      sb = sandbox({ startFails: true });
      assert.equal(sb.install('install').status, 0);
      fs.mkdirSync(path.join(sb.root, 'home/root/xovi/exthome/qt-resource-rebuilder'), { recursive: true });
      fs.writeFileSync(path.join(sb.root, 'home/root/xovi/exthome/qt-resource-rebuilder/hashtab'), 'x');
      r = sb.install('activate');
      assert.equal(r.status, 1);
      assert.match(r.stderr, /starting XOVI failed; the stock interface was restored/);
      assert.deepEqual(sb.xoviState(), ['stock'], 'the stock script ran after the failed start');
      notes.push('XOVI start failure → stock restored, exit 1');
      // 6. Untrusted host key: stop with instructions.
      sb = sandbox(); before = tree(sb.root, notTmp);
      r = sb.install('install', [], { FAKE_SSH_HOSTKEY_FAIL: '1' });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /SSH host key is not trusted.*compare the fingerprint/s);
      assert.deepEqual(tree(sb.root, notTmp), before);
      // No permanent stock change anywhere: system files identical after a full install + uninstall.
      sb = sandbox();
      const sys = () => tree(sb.root, (rel) => !(rel.startsWith('etc') || rel.startsWith('usr') || rel.startsWith('sys') || rel.startsWith('home/root/.config/remarkable')));
      const sysBefore = sys();
      assert.equal(sb.install('install').status, 0);
      assert.deepEqual(sys(), sysBefore, 'install wrote nothing under /etc, /usr or the reMarkable settings (no update-policy, unit or firmware change)');
      const log = fs.readFileSync(path.join(sb.top, 'ssh.log'), 'utf8');
      assert.ok(!/systemctl (disable|mask|stop)|update|swupdate|dd |mount -o remount/.test(log), 'the installer issued no disabling, update or flashing command');
      t.note(notes.join('; ') + '; untrusted host key → stop with instructions; no system file changed');
    },

    async unsupported_report(t) {
      const sb = sandbox({ version: '3.31.0.9' });
      const before = tree(sb.root, notTmp);
      const r = sb.install('install');
      assert.equal(r.status, 4, `exit code names the reason (version): ${r.stderr}`);
      assert.match(r.stdout, /Tablet software version: 3\.31\.0\.9/, 'the Mac gets the exact version immediately');
      assert.match(r.stderr, /NOT SUPPORTED: software version 3\.31\.0\.9 is not supported \(supported: 3\.28\)/);
      assert.match(r.stderr, /Nothing was installed or changed on the tablet/);
      assert.match(r.stderr, /manual step and has NOT been done/, 'the manual import is reported as required, not completed');
      assert.deepEqual(tree(sb.root, notTmp), before, 'the tablet is untouched');
      assert.ok(!fs.existsSync(path.join(sb.root, 'tmp/matrix-rm2')), 'the staging directory was removed');
      const tokens = L.eink(sb.home).list();
      assert.ok(tokens.every((q) => q.revoked), 'no live device token is left for a tablet that was refused');
      // The PDF for the stock reader: extract its text at runtime.
      const pdf = fs.readFileSync(path.join(sb.reportDir, 'matrix-rm2-diagnostic.pdf'));
      assert.equal(pdf.subarray(0, 8).toString(), '%PDF-1.4');
      assert.ok(pdf.toString('latin1').trimEnd().endsWith('%%EOF'));
      const xref = Number(/startxref\n(\d+)/.exec(pdf.toString('latin1'))[1]);
      assert.equal(pdf.subarray(xref, xref + 4).toString(), 'xref', 'the cross-reference table is where the trailer says');
      const text = [...pdf.toString('latin1').matchAll(/\((.*)\) Tj/g)].map((m) => m[1].replace(/\\([\\()])/g, '$1')).join('\n');
      for (const want of ['NOT SUPPORTED', '3.31.0.9', 'not supported (supported: 3.28)', 'Device model: reMarkable 2.0', '[FAIL] software version', 'Nothing on the tablet was changed', 'imported over USB']) assert.ok(text.includes(want), `PDF contains: ${want}`);
      // Where the display is safe (supported version) a refusal is shown on screen instead: broken pairing.
      const st = L.tmp('st');
      const cfg = path.join(st, 'c.json'); fs.writeFileSync(cfg, JSON.stringify({ endpoints: [], token: '' }));
      const p = L.spawn(L.hostBin(), ['run', '--backend', 'capture', '--root', L.fixtureRoot(), '--state-dir', st, '--config', cfg], { stdio: ['pipe', 'pipe', 'pipe'] });
      L.registerProc(p);
      let out = ''; p.stdout.on('data', (d) => { out += d; });
      await L.until(() => out.includes('"firstrun"'), 15000, 'on-screen report');
      const screen = JSON.parse(out.split('\n')[0]).screen.join('\n');
      assert.match(screen, /\[FAIL\] pairing: .*config has no endpoints/, 'a problem that is safe to display is shown on the tablet itself');
      p.kill('SIGKILL');
      t.note(`unsupported 3.31.0.9: installer exit 4, exact version and reason on the Mac, tablet untouched, token revoked; PDF (${pdf.length} bytes) text extracted with version, reason and recovery steps; manual USB import stated as not done; supported-version problem shown on screen`);
    },
  };
};
