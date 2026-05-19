import os
import sys
import win32com.client

def convert_docx_to_pdf(docx_path, pdf_path=None):
    """
    将 DOCX 文件转换为 PDF
    
    Args:
        docx_path: DOCX 文件路径
        pdf_path: PDF 输出路径（可选，默认与 DOCX 同目录同名）
    
    Returns:
        bool: 转换是否成功
    """
    if not os.path.exists(docx_path):
        print(f"错误: 文件不存在 - {docx_path}")
        return False
    
    if pdf_path is None:
        pdf_path = os.path.splitext(docx_path)[0] + '.pdf'
    
    try:
        word = win32com.client.Dispatch("Word.Application")
        word.Visible = False
        
        doc = word.Documents.Open(os.path.abspath(docx_path))
        
        wdFormatPDF = 17  # PDF 格式代码
        doc.SaveAs(os.path.abspath(pdf_path), FileFormat=wdFormatPDF)
        
        doc.Close()
        word.Quit()
        
        print(f"成功: {docx_path} -> {pdf_path}")
        return True
        
    except Exception as e:
        print(f"错误: 转换失败 - {docx_path}")
        print(f"异常信息: {str(e)}")
        try:
            word.Quit()
        except:
            pass
        return False

def main():
    base_dir = r"e:\TK项目\数据大屏\开发\soft-copyright"
    
    files_to_convert = [
        os.path.join(base_dir, "source-code", "backend-source.docx"),
        os.path.join(base_dir, "source-code", "frontend-source.docx"),
        os.path.join(base_dir, "manual", "用户操作手册.docx"),
    ]
    
    success_count = 0
    fail_count = 0
    
    for docx_path in files_to_convert:
        if convert_docx_to_pdf(docx_path):
            success_count += 1
        else:
            fail_count += 1
    
    print(f"\n转换完成: 成功 {success_count} 个, 失败 {fail_count} 个")
    
    return 0 if fail_count == 0 else 1

if __name__ == "__main__":
    sys.exit(main())