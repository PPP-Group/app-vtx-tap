import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(92);
Config.setOverwriteOutput(true);
Config.setChromiumOpenGlRenderer('angle');
Config.setEntryPoint('src/index.ts');
// Usa o Chrome instalado (modo headless novo), sem baixar outro navegador.
Config.setBrowserExecutable('C:/Program Files/Google/Chrome/Application/chrome.exe');
Config.setChromeMode('chrome-for-testing');
