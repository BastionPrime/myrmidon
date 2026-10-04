#!/usr/bin/env python3

import subprocess
import sys
import os
import json
import argparse
from pathlib import Path
import tempfile


def run_command(cmd, cwd=None):
    """Run a shell command and return the result."""
    result = subprocess.run(
        cmd, 
        shell=True, 
        capture_output=True, 
        text=True, 
        cwd=cwd
    )
    if result.returncode != 0:
        raise Exception(f"Command failed: {cmd}\n{result.stderr}")
    return result


def read_vendor_base_commit():
    """Read the vendor base commit from the file."""
    vendor_base_file = "./scripts/myrmidon/vendor-base.txt"
    if not os.path.exists(vendor_base_file):
        raise FileNotFoundError(f"Vendor base file does not exist: {vendor_base_file}")
    
    with open(vendor_base_file, 'r') as f:
        content = f.read()
        
    commit_hash = content.strip().split('\n')[0].strip()
    if not commit_hash or len(commit_hash) != 40 or not all(c in '0123456789abcdefABCDEF' for c in commit_hash):
        raise ValueError(f"Invalid commit hash in vendor base file: {commit_hash}")
    
    return commit_hash


def get_current_files():
    """Get all files in the current commit."""
    result = run_command("git ls-files")
    return [os.path.abspath(f.strip()) for f in result.stdout.split('\n') if f.strip()]


def get_vendor_files(vendor_commit):
    """Get all files in the vendor base commit."""
    result = run_command(f"git ls-tree -r --name-only {vendor_commit}")
    return [os.path.abspath(f.strip()) for f in result.stdout.split('\n') if f.strip()]


def get_file_content_at_commit(file_path, commit_hash):
    """Get file content at a specific commit."""
    rel_path = os.path.relpath(file_path, os.getcwd())
    try:
        result = run_command(f"git show {commit_hash}:{rel_path}")
        return result.stdout
    except Exception:
        # If the file doesn't exist in that commit, return None
        return None


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


def analyze_vendor_share(threshold=0.5):
    """Main function to analyze vendor share."""
    print("Analyzing vendor share...")
    
    import time
    start_time = time.time()
    
    vendor_commit = read_vendor_base_commit()
    print(f"Using vendor base commit: {vendor_commit}")
    
    current_files = get_current_files()
    print(f"Total current files: {len(current_files)}")
    
    vendor_files = set(get_vendor_files(vendor_commit))
    print(f"Total vendor files: {len(vendor_files)}")
    
    # Filter files that exist in both current and vendor commits
    files_to_analyze = []
    for file_path in current_files:
        abs_file_path = os.path.abspath(file_path)
        if abs_file_path in vendor_files and not is_excluded(file_path):
            files_to_analyze.append(abs_file_path)
    
    print(f"Files to analyze: {len(files_to_analyze)}")
    
    vendor_derived_files = []
    total_files = len(files_to_analyze)
    
    for i, file_path in enumerate(files_to_analyze):
        if i % 100 == 0:
            print(f"Processing file {i}/{total_files}: {file_path}")
        
        try:
            # Get the file content at vendor commit
            rel_path = os.path.relpath(file_path, os.getcwd())
            vendor_content = get_file_content_at_commit(rel_path, vendor_commit)
            
            if vendor_content is None:
                # File existed in vendor commit but not anymore, skip
                continue
            
            # Get current file content
            with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                current_content = f.read()
            
            # Calculate similarity
            similarity = calculate_similarity(current_content, vendor_content)
            
            if similarity >= threshold:
                vendor_derived_files.append({
                    'path': file_path,
                    'similarity': similarity,
                    'vendor_content_length': len(normalize_content(vendor_content).split('\n')),
                    'current_content_length': len(normalize_content(current_content).split('\n'))
                })
        except Exception as e:
            print(f"Could not analyze file {file_path}: {str(e)}")
            continue
    
    end_time = time.time()
    print(f"Analysis completed in {(end_time - start_time):.2f} seconds")
    
    # Group by top-level directories
    by_directory = {}
    by_package = {}
    
    for file_data in vendor_derived_files:
        rel_path = os.path.relpath(file_data['path'])
        parts = rel_path.split('/')
        top_level_dir = parts[0] if parts else '.'
        
        if top_level_dir not in by_directory:
            by_directory[top_level_dir] = {'count': 0, 'files': []}
        by_directory[top_level_dir]['count'] += 1
        by_directory[top_level_dir]['files'].append(rel_path)
        
        # Look for package.json in parent directories to group by package
        current_dir = os.path.dirname(file_data['path'])
        package_root = None
        
        while current_dir != '/' and current_dir != '.':
            package_json_path = os.path.join(current_dir, 'package.json')
            if os.path.exists(package_json_path):
                package_root = current_dir
                break
            current_dir = os.path.dirname(current_dir)
        
        if package_root:
            try:
                with open(os.path.join(package_root, 'package.json'), 'r') as f:
                    pkg_data = json.load(f)
                package_name = pkg_data.get('name') or os.path.basename(package_root)
            except:
                package_name = os.path.basename(package_root)
                
            if package_name not in by_package:
                by_package[package_name] = {'count': 0, 'files': []}
            by_package[package_name]['count'] += 1
            by_package[package_name]['files'].append(rel_path)
    
    # Prepare results
    results = {
        'total_files': len(current_files),
        'vendor_derived_files': len(vendor_derived_files),
        'vendor_share': len(current_files) > 0 and len(vendor_derived_files) / len(current_files) or 0,
        'threshold_used': threshold,
        'vendor_commit': vendor_commit,
        'vendor_derived_list': [
            {'path': os.path.relpath(f['path']), 'similarity': f['similarity']} 
            for f in vendor_derived_files
        ],
        'by_directory': by_directory,
        'by_package': by_package,
        'analysis_time_ms': int((end_time - start_time) * 1000)
    }
    
    return results


def print_markdown_summary(results):
    """Print results in markdown format."""
    print("\n# Vendor Share Analysis Results\n")
    print(f"- Total files: {results['total_files']}")
    print(f"- Vendor-derived files: {results['vendor_derived_files']}")
    print(f"- Vendor share: {(results['vendor_share'] * 100):.2f}%")
    print(f"- Threshold used: {(results['threshold_used'] * 100):.2f}%")
    print(f"- Analysis time: {results['analysis_time_ms']}ms\n")
    
    print("## Files by Top-Level Directory\n")
    for dir_name, data in results['by_directory'].items():
        print(f"- {dir_name}: {data['count']} files")
    
    print("\n## Files by Package\n")
    for pkg_name, data in results['by_package'].items():
        print(f"- {pkg_name}: {data['count']} files")
    
    print("\n## Sample of Vendor-Derived Files\n")
    sample_files = results['vendor_derived_list'][:10]
    for file_info in sample_files:
        print(f"- {file_info['path']} ({file_info['similarity']*100:.2f}%)")
    
    if len(results['vendor_derived_list']) > 10:
        print(f"... and {len(results['vendor_derived_list']) - 10} more files")


def main():
    parser = argparse.ArgumentParser(description="Analyze vendor share in the repository")
    parser.add_argument("--threshold", "-t", type=float, default=0.5, 
                        help="Similarity threshold for vendor classification (0-1, default: 0.5)")
    parser.add_argument("--json", action="store_true", 
                        help="Output results in JSON format")
    parser.add_argument("--markdown", action="store_true", 
                        help="Output results in Markdown format (default)")
    
    args = parser.parse_args()
    
    try:
        results = analyze_vendor_share(args.threshold)
        
        if args.json:
            print(json.dumps(results, indent=2))
        else:
            print_markdown_summary(results)
    except Exception as e:
        print(f"Error during analysis: {str(e)}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()