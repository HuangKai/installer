// This file is required by the index.html file and will
// be executed in the renderer process for that window.
// All of the Node.js APIs are available in this process.
const electron = require('electron');
const { remote } = electron;
const { app, dialog } = remote;
const asar = require('asar');
const path = require('path');
var fs = require('fs-extra');
var originalFs = require('original-fs');
const $ = require('jquery');
const unhandled = require('electron-unhandled');
const { openNewGitHubIssue, debugInfo } = require('electron-util');
const store = require('./store');

let removeSync;

if (process.platform === 'darwin') {
  const jetpack = require('fs-jetpack');
  removeSync = jetpack.remove;
}
else if (process.platform === 'win32') {
  removeSync = fs.removeSync;
}

unhandled({
  showDialog: true,
  reportButton: error => {
    openNewGitHubIssue({
      user: 'cdes',
      repo: 'figma-plugin-manager-desktop',
      body: `\`\`\`\n${error.stack}\n\`\`\`\n\n---\n\n${debugInfo()}`
    });
  }
});

// setup paths
let originalAsar;
let signature;
let figmaAppLocation = '/Applications/Figma.app';
const rootFolder = process.env.NODE_ENV === 'development'
  ? process.cwd()
  : path.resolve(app.getAppPath(), './');

const checkInjection = () => {
  const devmodebtn = $('#devmode');
  if (fs.existsSync(signature)) {
    show('uninstall');

    if (store.get('devMode', false)) {
      devmodebtn.html(devmodebtn.html().replace("Turn On", "Turn Off"));
    }
    else {
      devmodebtn.html(devmodebtn.html().replace("Turn Off", "Turn On"));
    }
  }
  else if (fs.existsSync(originalAsar)) {
    show('install');
    devmodebtn.html(devmodebtn.html().replace("Turn Off", "Turn On"));
  }
  else {
    show('locating');
  }
}

function setupPaths(location) {

  if (process.platform === 'darwin') {
    figmaAppLocation = location ? location : figmaAppLocation;
  }
  else if (process.platform === 'win32') {
    // the asar is in a versioned directory on windows,
    // so need to figure out the directory name

    const figmaDir = `${app.getPath('appData').slice(0, -7)}Local\\Figma`;

    const dirs = fs.readdirSync(figmaDir)
      .filter(f =>
        fs.statSync(path.join(figmaDir, f)).isDirectory()
        && f.startsWith('app-'));

    dirs.sort().reverse();

    figmaAppLocation = location ? location : `${figmaDir}/${dirs[0]}`;
  }

  switch (process.platform) {
    case 'darwin':
      originalAsar = `${figmaAppLocation}/Contents/Resources/app.asar`;
      signature = `${figmaAppLocation}/Contents/Resources/figments.json`;
      break;
    case 'win32':
      originalAsar = `${figmaAppLocation}/resources/app.asar`;
      signature = `${figmaAppLocation}/resources/figments.json`;
      break;
    default:
      throw new Error('This platform is not supported at this time.');
  }

  $('#path').text(figmaAppLocation);

  checkInjection();
}

setupPaths();

function hideAll() {
  $('#locating').removeClass('show');
  $('#install').removeClass('show');
  $('#uninstall').removeClass('show');
  $('#error').removeClass('show');
}

function show(id) {
  const element = $(`#${id}`);
  if (!element.hasClass('show')) {
    hideAll();
    $(`#${id}`).addClass('show');
    $(`#${id} button`).removeClass();
  }

  if (id !== 'locating') {
    $('#dropdown').show();
  }
  else {
    $('#dropdown').hide();
  }
}

let pollInjection = null;

locateFigmaApp = () => {
  if (fs.existsSync(originalAsar) && !fs.existsSync(signature)) {
    $('#path').text(figmaAppLocation);
    show('install');
    checkInjection();
    pollInjection = setInterval(checkInjection, 2000);
  }
}


locateFigmaApp();
const pollLocateFigmaApp = setInterval(locateFigmaApp, 2000);

async function checkFigmaBeforeRunning(task) {
  const psList = require('ps-list');
  const kill = require('tree-kill');

  const ps = await psList();
  let figmaProcess;
  switch (process.platform) {
    case 'darwin':
      figmaProcess = ps.filter(p => p.name === 'Figma');
      break;
    case 'win32':
      figmaProcess = ps.filter(p => p.name === 'Figma.exe');
      break;
    default:
      throw new Error('This platform is not supported at this time.');
  }
  const figmaIsRunning = figmaProcess.length > 0;

  if (figmaIsRunning) {
    dialog.showMessageBox({
      type: 'info',
      message: 'Figma app is still open, you must quit it first.  Make sure to save your progress before quitting Figma.',
      buttons: ['Quit Figma', 'Cancel']
    }, (resp) => {
      if (resp === 0) {
        // User selected 'Quit Figma'
        kill(figmaProcess[0].pid);
        task();
        runFigma();
      }
      else {
        $('button').removeClass();
      }
    });
  }
  else {
    task();
    runFigma();
  }
}

function runFigma() {
  const exec = require('child_process').exec;
  const execFile = require('child_process').execFile;

  setTimeout(() => {
    if (process.platform === 'darwin') {
      exec(`open ${figmaAppLocation}`);
    }
    else if (process.platform === 'win32') {
      execFile(`${app.getPath('appData').slice(0, -7)}Local\\Figma/Figma.exe`);
    }
  }, 2000);
}

function startInjecting() {
  const userData = app.getPath('userData');
  const backupAsar = `${originalAsar}.bk`;

  var input = `${userData}/input`;
  var output = `${userData}/output/app.asar`;

  var targetFile = `${userData}/input/window_manager.js`;
  var insertAfter = "this.webContents.on('dom-ready', () => {";

  var code = fs.readFileSync(`${rootFolder}/code.js`, 'utf8');

  if (fs.existsSync(output)) removeSync(output);
  if (fs.existsSync(input)) removeSync(input);

  // replace injected packs with backups
  if (fs.existsSync(backupAsar)) {
    if (fs.existsSync(originalAsar)) removeSync(originalAsar);
    removeSync(originalAsar);
    originalFs.copyFileSync(backupAsar, originalAsar);
    removeSync(backupAsar);
  }

  // bring figma files
  asar.extractAll(originalAsar, input);


  // inject code

  const useLocalPluginsManager = store.get('useLocalPluginsManager', false);

  if (useLocalPluginsManager) {
    const localPluginsManagerUrl = store.get('localPluginsManagerUrl', "https://jachui.github.io/figma-plugin-manager");
    code = code.replace(/SERVER_URL/g, localPluginsManagerUrl.replace(/\/$/, ""));
  }
  else {
    code = code.replace(/SERVER_URL/g, "https://jachui.github.io/figma-plugin-manager");
  }

  const devMode = store.get('devMode', false);

  // enable developer mode in the plugin manager
  if (devMode) {
    const pluginDevMode = `
    this.webContents.executeJavaScript('window.pluginDevMode = true;');
    `;
    code = pluginDevMode + code;
  }

  const inject = require('inject-code');

  if (devMode || useLocalPluginsManager) {
    // since we will serve local manager from http, we need this
    inject(
      "webSecurity: false,",
      {
        into: targetFile,
        after: "preload: path.join(__dirname, preloadScript),",
        sync: true,
        contentType: 'code',
        newLine: 'auto'
      }
    );
  }

  // inject our manager code
  inject(
    code,
    {
      into: targetFile,
      after: insertAfter,
      sync: true,
      contentType: 'code',
      newLine: 'auto'
    }
  );

  asar.createPackageWithOptions(input, output, { unpackDir: `${input}/*.node` }, writePacked);

  function writePacked() {
    if (fs.existsSync(output)) {
      originalFs.copyFileSync(originalAsar, originalAsar + '.bk');
      removeSync(originalAsar);
      originalFs.copyFileSync(output, originalAsar);
      fs.writeJsonSync(signature, { dateInjected: (new Date()).toString() })
      checkInjection();
    }
    else {
      dialog.showErrorBox('File not found', output);
    }
  }
}

function uninject() {
  const backupAsar = `${originalAsar}.bk`;

  if (fs.existsSync(backupAsar)) {
    removeSync(originalAsar);
    originalFs.copyFileSync(backupAsar, originalAsar);
    removeSync(backupAsar);
    removeSync(signature);
    checkInjection();
  }
}

function locate() {

  let dialogTitle = "Select Figma Folder";
  let properties = ["openDirectory"];
  let filters = [];

  if (process.platform === 'darwin') {
    dialogTitle = "Select Figma.app";
    properties = ["openFile"];
    filters = [{ name: 'App', extensions: ['app'] }]
  }

  dialog.showOpenDialog({
    title: dialogTitle,
    properties: properties,
    filters: filters,
  }, (paths) => {
    if (paths === undefined) {
      console.log("No destination folder selected");
      return;
    } else {
      setupPaths(paths[0]);
    }
  });
}

$('#inject').click(() => {
  store.set('devMode', false);
  $('#inject').addClass('loading outline');
  checkFigmaBeforeRunning(startInjecting);
});

$('#uninject').click(() => {
  $('#uninject').addClass('loading outline');
  checkFigmaBeforeRunning(uninject);
});

$('#locate').click(() => {
  $('#locate').addClass('loading');
  locate();
});

$('#devmode').click(() => {
  store.set('devMode', !store.get('devMode', false));
  $('#inject').addClass('loading outline');
  checkFigmaBeforeRunning(startInjecting);
});

$('#close').click(() => {
  app.quit();
});