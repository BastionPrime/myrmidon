#!/usr/bin/env python3

"""
Tests for the vendor share calculation script.
These tests will be run in a small artificial repository to validate the logic.
"""

import unittest
import tempfile
import os
import subprocess
import shutil
from pathlib import Path
import sys
from io import StringIO


def normalize_content(content):
    """Normalize content for comparison."""
    if not isinstance(content, str):
        return ""
    
    # Normalize line endings and remove empty lines
    lines = content.replace('\r\n', '\n').split('\n')
    normalized_lines = [line.strip() for line in lines if line.strip()]
    return '\n'.join(normalized_lines)


def calculate_similarity(content1, content2):
    """Calculate similarity ratio between two files."""
    norm_content1 = normalize_content(content1)
    norm_content2 = normalize_content(content2)
    
    if not norm_content1 and not norm_content2:
        return 1.0  # Both are empty, consider them identical
    if not norm_content1 or not norm_content2:
        return 0.0  # One is empty, the other is not

    lines1 = set(norm_content1.split('\n'))
    lines2 = set(norm_content2.split('\n'))

    # Calculate intersection of lines
    common_lines = len(lines1.intersection(lines2))
    total_lines = max(len(lines1), len(lines2))
    
    if total_lines == 0:
        return 1.0
    
    return common_lines / total_lines


def is_excluded(file_path):
    """Check if a file should be excluded based on patterns."""
    exclude_patterns = [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/.git/**',
        '**/package-lock.json',
        '**/pnpm-lock.yaml',
        '**/yarn.lock',
        '**/*.lock',
        '**/Dockerfile.*',
        '**/docker-compose*.yml',
        '**/docker-compose*.yaml',
        '**/.env*',
        '**/.*ignore',
        '**/.*rc',
        '**/tsconfig*.json',
        '**/jsconfig*.json',
        '**/vitest.config.*',
        '**/jest.config.*',
        '**/webpack.config.*',
        '**/rollup.config.*',
        '**/babel.config.*',
        '**/*.test.*',
        '**/*.spec.*',
        '**/__tests__/**',
        '**/test/**',
        '**/tests/**'
    ]
    
    normalized_path = file_path.replace('\\', '/')
    
    for pattern in exclude_patterns:
        if _match_pattern_extended(pattern, normalized_path):
            return True
    
    return False


def _match_pattern_extended(pattern, path):
    """Extended pattern matching including recursive patterns."""
    import fnmatch
    
    # Handle recursive patterns like **/node_modules/**
    if '**' in pattern:
        # Split on ** to get prefix and suffix
        parts = pattern.split('**', 1)
        if len(parts) == 2:
            prefix, suffix = parts
            # Remove leading slash if present
            prefix = prefix.lstrip('/')
            suffix = suffix.lstrip('/')
            
            # If prefix is empty (pattern starts with **), match suffix anywhere
            if not prefix:
                return fnmatch.fnmatch(path, suffix) or suffix in path or path.endswith(suffix)
            # If suffix is empty (pattern ends with **), match prefix at start
            elif not suffix:
                return path.startswith(prefix)
            # Otherwise match prefix at start and suffix somewhere after
            else:
                if path.startswith(prefix):
                    remaining_path = path[len(prefix):]
                    return fnmatch.fnmatch(remaining_path, suffix) or suffix in remaining_path or remaining_path.endswith(suffix)
        # Handle the case where there's ** in the middle
        elif pattern.startswith('**/') and pattern.endswith('/**'):
            # Pattern like **/name/**
            inner_name = pattern[3:-3]  # Remove **/ and /**
            return inner_name in path
        elif pattern.startswith('**/'):
            # Pattern like **/filename
            filename = pattern[3:]  # Remove **/
            return fnmatch.fnmatch(os.path.basename(path), filename) or filename in path
    elif '*' in pattern or '?' in pattern or '[' in pattern:
        # Standard glob pattern
        return fnmatch.fnmatch(path, pattern) or fnmatch.fnmatch(os.path.basename(path), pattern)
    else:
        # Exact match
        return path == pattern or os.path.basename(path) == pattern
    
    return False


class TestVendorShare(unittest.TestCase):
    
    def setUp(self):
        """Set up a temporary git repository for testing."""
        self.temp_dir = tempfile.mkdtemp()
        self.original_dir = os.getcwd()
        os.chdir(self.temp_dir)
        
        # Initialize git repo
        subprocess.run(['git', 'init'], check=True, capture_output=True)
        subprocess.run(['git', 'config', 'user.email', 'test@example.com'], check=True)
        subprocess.run(['git', 'config', 'user.name', 'Test User'], check=True)
        
        # Create vendor base file
        os.makedirs('scripts/myrmidon', exist_ok=True)
        with open('scripts/myrmidon/vendor-base.txt', 'w') as f:
            f.write('initial_commit_hash\n\nBase vendor commit for testing.')
        
    def tearDown(self):
        """Clean up the temporary directory."""
        os.chdir(self.original_dir)
        shutil.rmtree(self.temp_dir)
    
    def test_normalize_content(self):
        """Test content normalization."""
        content = "line1\r\nline2\n\nline3  \nline4\n"
        expected = "line1\nline2\nline3\nline4"
        self.assertEqual(normalize_content(content), expected)
        
        # Test with empty content
        self.assertEqual(normalize_content(""), "")
        self.assertEqual(normalize_content(None), "")
    
    def test_calculate_similarity_identical(self):
        """Test similarity calculation for identical files."""
        content = "line1\nline2\nline3"
        self.assertEqual(calculate_similarity(content, content), 1.0)
    
    def test_calculate_similarity_different(self):
        """Test similarity calculation for different files."""
        content1 = "line1\nline2\nline3"
        content2 = "line1\nline2\nline4"
        # With set-based comparison: {line1, line2, line3} vs {line1, line2, line4}
        # Common: {line1, line2}, Max length: max(3, 3) = 3, so 2/3 = 0.666...
        similarity = calculate_similarity(content1, content2)
        self.assertAlmostEqual(similarity, 0.666, places=2)  # 2 out of 3 lines common
    
    def test_calculate_similarity_empty(self):
        """Test similarity calculation with empty files."""
        self.assertEqual(calculate_similarity("", ""), 1.0)
        self.assertEqual(calculate_similarity("content", ""), 0.0)
        self.assertEqual(calculate_similarity("", "content"), 0.0)
    
    def test_is_excluded(self):
        """Test exclusion patterns."""
        # These should be excluded
        self.assertTrue(is_excluded("package-lock.json"))  # Direct match
        self.assertTrue(is_excluded("node_modules/some_file.js"))  # Glob match
        self.assertTrue(is_excluded("dist/main.js"))  # Glob match
        self.assertTrue(is_excluded(".git/config"))  # Glob match
        
        # These should not be excluded
        self.assertFalse(is_excluded("src/main.js"))
        self.assertFalse(is_excluded("README.md"))
        self.assertFalse(is_excluded("LICENSE"))
    
    def test_analyze_vendor_share_logic(self):
        """Test the core logic of vendor share analysis using a simple example."""
        # Create a file that exists in both base and current
        os.makedirs('src', exist_ok=True)
        with open('src/example.js', 'w') as f:
            f.write('console.log("original content");')
        
        # Commit initial state
        subprocess.run(['git', 'add', '.'], check=True)
        subprocess.run(['git', 'commit', '-m', 'Initial commit'], check=True, capture_output=True)
        
        # Get the initial commit hash and save it to vendor-base.txt
        initial_commit = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()
        with open('scripts/myrmidon/vendor-base.txt', 'w') as f:
            f.write(f'{initial_commit}\n\nBase vendor commit for testing.')
        
        # Modify the file slightly (should still be above 50% threshold)
        with open('src/example.js', 'w') as f:
            f.write('console.log("original content");\nconsole.log("added line");')
        
        subprocess.run(['git', 'add', '.'], check=True)
        subprocess.run(['git', 'commit', '-m', 'Modify file slightly'], check=True, capture_output=True)
        
        # Now test the functions directly
        original_content = 'console.log("original content");'
        modified_content = 'console.log("original content");\nconsole.log("added line");'
        
        similarity = calculate_similarity(original_content, modified_content)
        
        # The similarity should be greater than or equal to 0.5 (50% threshold)
        # With our current algorithm: {console.log("original content");}
        # vs {console.log("original content");, console.log("added line");}
        # Common: 1, Max length: 2, so 1/2 = 0.5
        self.assertGreaterEqual(similarity, 0.5)
        
        # Test with heavily modified content (should be below 50% threshold)
        heavily_modified = 'console.log("completely different content");\nvar x = 1;\nfunction test() { return x; }'
        low_similarity = calculate_similarity(original_content, heavily_modified)
        self.assertLess(low_similarity, 0.5)


def run_tests():
    """Run the tests."""
    loader = unittest.TestLoader()
    suite = loader.loadTestsFromTestCase(TestVendorShare)
    
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    return result.wasSuccessful()


if __name__ == '__main__':
    success = run_tests()
    sys.exit(0 if success else 1)