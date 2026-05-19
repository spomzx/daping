# PowerShell script to convert DOCX to PDF

$ErrorActionPreference = "Stop"

function Convert-DocxToPdf {
    param(
        [string]$DocxPath,
        [string]$PdfPath
    )
    
    if (-not (Test-Path $DocxPath)) {
        Write-Host "Error: File not found - $DocxPath" -ForegroundColor Red
        return $false
    }
    
    if ([string]::IsNullOrEmpty($PdfPath)) {
        $PdfPath = [System.IO.Path]::ChangeExtension($DocxPath, ".pdf")
    }
    
    try {
        $word = New-Object -ComObject Word.Application
        $word.Visible = $false
        $word.DisplayAlerts = 0
        
        $doc = $word.Documents.Open($DocxPath)
        
        $wdFormatPDF = 17
        $doc.SaveAs($PdfPath, $wdFormatPDF)
        
        $doc.Close([ref]$false)
        $word.Quit([ref]$false)
        
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
        [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
        
        Write-Host "Success: $DocxPath -> $PdfPath" -ForegroundColor Green
        return $true
    }
    catch {
        Write-Host "Error: Conversion failed - $DocxPath" -ForegroundColor Red
        Write-Host "Exception: $_" -ForegroundColor Red
        
        try {
            if ($doc) { $doc.Close([ref]$false) }
            if ($word) { $word.Quit([ref]$false) }
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc) | Out-Null
            [System.Runtime.Interopservices.Marshal]::ReleaseComObject($word) | Out-Null
        } catch {}
        
        return $false
    }
}

$currentDir = Get-Location
$baseDir = Join-Path $currentDir "soft-copyright"

$file1 = Join-Path $baseDir "source-code\backend-source.docx"
$file2 = Join-Path $baseDir "source-code\frontend-source.docx"

$manualDir = Join-Path $baseDir "manual"
$file3 = Get-ChildItem -Path $manualDir -Filter "*.docx" | Select-Object -First 1 -ExpandProperty FullName

$filesToConvert = @($file1, $file2, $file3)

$successCount = 0
$failCount = 0

foreach ($docxPath in $filesToConvert) {
    if ([string]::IsNullOrEmpty($docxPath)) {
        Write-Host "Skipping empty path" -ForegroundColor Yellow
        continue
    }
    
    if (Convert-DocxToPdf -DocxPath $docxPath) {
        $successCount++
    } else {
        $failCount++
    }
}

Write-Host "Conversion complete: Success $successCount, Failed $failCount" -ForegroundColor Cyan

if ($failCount -gt 0) {
    exit 1
} else {
    exit 0
}