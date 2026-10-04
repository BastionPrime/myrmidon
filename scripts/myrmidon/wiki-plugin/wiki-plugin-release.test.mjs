import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Test to verify that the wiki plugin can be built successfully
// This simulates the CI build process for the wiki plugin
async function testWikiPluginBuild() {
  console.log('Testing LLM Wiki plugin build process...');
  
  // Change to the plugin directory
  const pluginDir = join(process.cwd(), 'packages', 'plugins', 'plugin-llm-wiki');
  
  if (!existsSync(pluginDir)) {
    throw new Error(`Plugin directory does not exist: ${pluginDir}`);
  }
  
  console.log(`Changing to directory: ${pluginDir}`);
  process.chdir(pluginDir);
  
  // Run the build command
  console.log('Running build command...');
  try {
    const buildOutput = execSync('pnpm build', { encoding: 'utf-8' });
    console.log('Build output:', buildOutput);
    
    // Verify that the expected output files exist
    const expectedOutputs = [
      'dist/manifest.js',
      'dist/worker.js',
      'dist/ui/index.html'  // Assuming there's a UI build
    ];
    
    for (const outputPath of expectedOutputs) {
      const fullPath = join(pluginDir, outputPath);
      if (!existsSync(fullPath)) {
        throw new Error(`Expected output file does not exist: ${fullPath}`);
      }
      console.log(`✓ Found expected output: ${outputPath}`);
    }
    
    console.log('✓ All expected build outputs found');
  } catch (error) {
    console.error('Build failed:', error);
    throw error;
  }
  
  // Run tests
  console.log('Running tests...');
  try {
    const testOutput = execSync('pnpm test', { encoding: 'utf-8' });
    console.log('Test output:', testOutput);
    console.log('✓ Tests passed');
  } catch (error) {
    console.error('Tests failed:', error);
    throw error;
  }
  
  console.log('✓ LLM Wiki plugin build test completed successfully');
}

// Run the test
testWikiPluginBuild()
  .then(() => {
    console.log('All tests passed!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Test failed:', error);
    process.exit(1);
  });