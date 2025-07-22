import os
import json
import pypyodbc as pod
#import msal
from collections import defaultdict
from argparse import ArgumentParser
from pathlib import Path
import pandas as pd


def database_connection(dbDriver, dbServer, dbName):
    # Define the connection string
    # Replace the placeholders with your actual server, database, username, and password
    # conn_str = 'Driver={ODBC Driver 17 for SQL Server};Server=AZWDBPCACSQL05\\GWAMSQL16P02;Database=RMDB;Trusted_Connection=yes'
    conn_str = 'Driver={driver};Server={server};Database={db};Trusted_Connection=yes' \
            .format(driver = "{"+dbDriver+"}", server = dbServer, db= dbName)

    # Connect to the SQL Server database
    try:
        conn = pod.connect(conn_str)
        #print("\nConnected to the database successfully.\n")
        return conn
    except pod.Error as e:
        print("\nError connecting to database:", e)
        exit()

# Function to parse the curve definition file
def parse_curve_definitions(filename):
    curve_names = []
    if len(filename) > 0: 
        try:
            with open(filename, 'r') as file:
                for line in file:
                    if line.startswith("CurveName\t"):
                        # Extract the curve name
                        _, curve_name = line.split('\t')
                        curveCategory, curveType = "", ""
                        passParam = False
                        for line in file:
                            if passParam and len(line.strip()) == 0:
                                break
                            if line.startswith("///:Parameter"):
                                passParam = True
                            if line.startswith("CurveCategory\t"):
                                _, curveCategory = line.split('\t')
                            if line.startswith("CurveType\t"):
                                _, curveType = line.split('\t')
                        curve_names.append((curve_name.strip(), curveCategory.strip(), curveType.strip()))

        except Exception as e:
            print("Cannot open file " + filename)
            exit()

    return curve_names

# Get CPI curve data
def CPI_Curves(CPIcurves):

    # CurveName = 'CPI_MarketData.USD'    
    cpi_hist = """
declare @CurveInstanceDate date = ?;
SELECT CurveName, CurveDate, EffectiveMid
FROM [Market].[vCurveData] 
where CurveInstanceDate = @CurveInstanceDate 
 and CurveName LIKE 'CPI_MarketData%' 
 and InstanceType = 'NA' 
 and category = 'Spot' 
 and CurveDate <= EOMONTH(@CurveInstanceDate, -1) 
Order by CurveName, ID;
"""

    # CurveName LIKE 'CPI_SeasonalityRates.USD' 
    cpi_season = """
declare @CurveInstanceDate date = ?;
SELECT CurveName, Month = Replace(TenorName, 'Factor', ''), Rate = EffectiveMid
FROM [Market].[vCurveData] 
where CurveInstanceDate = @CurveInstanceDate 
 and CurveName LIKE 'CPI_SeasonalityRates%' 
 and InstanceType = 'NA' 
Order by CurveName, ID;
"""

    # CurveName = 'CPI_MarketData.USD' 
    cpi_ZCIS = """
declare @CurveInstanceDate date = ?;    
SELECT CurveName, ZCIS = 'ZCIS', 
  Years = Replace(TenorName, 'y', ''), 
  Yield = InputMid * 100 
FROM [Market].[vCurveData] 
where CurveInstanceDate = @CurveInstanceDate 
and CurveName LIKE 'CPI_MarketData%' 
and InstanceType = 'NA' 
and category = 'Forward' 
Order by CurveName, ID;
"""

    conn = database_connection(db_driver, db_server, db_name)
    cursor = conn.cursor()
    cursor.execute(cpi_hist, (arg_curve_date,))
    cursor_hist  = cursor.fetchall()
     # Process results to group by CurveName
    curve_hist = defaultdict(list)
    for row in cursor_hist:
        curve_name = row[0]
        details = (row[1], row[2])
        curve_hist[curve_name].append(details)

    cursor.execute(cpi_season, (arg_curve_date,))
    cursor_season  = cursor.fetchall()
    curve_season = defaultdict(list)
    for row in cursor_season:
        curve_name = row[0]
        details = (row[1], row[2])
        curve_season[curve_name].append(details)

    cursor.execute(cpi_ZCIS, (arg_curve_date,))
    cursor_ZCIS = cursor.fetchall()
    curve_ZCIS = defaultdict(list)
    for row in cursor_ZCIS:
        curve_name = row[0]
        details = (row[1], row[2], round(row[3], 4))
        curve_ZCIS[curve_name].append(details)

    conn.close()
    # Track curves that do not have data
    curves_without_data = []

    # Open a text file in write mode
    with open(arg_curveQuote_out, 'a') as file:
        # Iterate over each defined curve
        for curve_name in CPIcurves:
            # Get curve historical data
            parts = curve_name.split('.')
            if len(parts) >= 2:
                base_name = '.'.join(parts[:-1])    # All parts except the last one
                last_part = parts[-1]               # The last part
                curve_alias_market = f"{base_name}_MarketData.{last_part}"
                curve_alias_season = f"{base_name}_SeasonalityRates.{last_part}"
            else: 
                curve_alias_market = curve_name
                curve_alias_season = curve_name

            if curve_alias_market in curve_ZCIS:    
                file.write(f"#BeginCurve\n")
                file.write(f"CurveName\t{curve_name}\n\n")
                file.write(f"///:Parameter\nName\tValue\n")
                file.write(f"CurveCategory\tCPICurve\n")
                file.write(f"CurveDate\t{arg_curve_date}\n\n")
            else:
                # Track this curve as missing from data
                curves_without_data.append(curve_name)                


            if curve_alias_market in curve_hist:
                file.write(f"///:HistoricalCPI\n")
                file.write("Date\tRate\n")
                # Write each row to the file
                curve = curve_hist[curve_alias_market]
                for curveDate, rate in curve:
                    file.write('\t'.join(str(item) if item is not None else 'NULL' for item in (curveDate, rate)) + '\n')
                file.write('\n')

            # Get seasonalalityRates
            if curve_alias_season in curve_season:    
                file.write(f"///:SeasonalityRate\n")
                file.write("Month\tRate\n")
                # Write each row to the file
                curve = curve_season[curve_alias_season]
                for month, rate in curve:
                    file.write('\t'.join(str(item) if item is not None else 'NULL' for item in (month, rate)) + '\n')
                file.write('\n')

            if curve_alias_market in curve_ZCIS:    
                file.write(f"///:ZeroCouponInflationSwap\n")
                file.write("ZCIS\tYears\tYield\n")
                # Write each row to the file
                curve = curve_ZCIS[curve_alias_market]
                for zsic, years, yld in curve:
                    file.write('\t'.join(str(item) if item is not None else 'NULL' for item in (zsic, years, yld)) + '\n')
                file.write('\n#EndCurve\n\n')

    return curves_without_data

def GetBondSpotCurves():
    curves = defaultdict(list)
    bondSpot_query = """
	select CurveName,
        Ticker as Cusip,
        Price*100 as Price,
        CouponRate,
        SecType,
        DiscountCurveName as DiscountCurve,
        StartDate,
        MaturityDate,
        SettlementDays,
        PaymentPeriod,
        Notional,
        DayCount,
        DateRoll,
        DiscountCurveCalendarname as Calendar,
        Issuer,
        SettleLag,
        LagDayType
	from [Market].[vCurveData4PVT_PriceCurve]
	WHERE InstanceRankOrder=1
	and CurveInstanceDate = ?
	order by CurveName, Cusip
    """

    conn = database_connection(db_driver, db_server, db_name)
    cursor = conn.cursor()
    cursor.execute(bondSpot_query, (arg_curve_date,))
    curve_rows  = cursor.fetchall()
     # Process results to group by CurveName
    for row in curve_rows:
        curve_name = row[0]
        details = (row[1], row[2], row[3], row[4], row[5], row[6], row[7], row[8], row[9], row[10], row[11], row[12], row[13], row[14], row[15], row[16])
        curves[curve_name].append(details)

    conn.close()
    return curves

def GetPriceCurves(curveName):
    curves = defaultdict(list)
    spotPrice_query = """
        SELECT 
            d.CurveName, 
            d.TenorName AS Tenor, 
            d.Price 
        FROM Market.vCurveData4PVT AS d 
        WHERE d.InstanceRankOrder=1
        AND d.CurveInstanceDate = ?
        AND d.CurveName = ?
        ORDER BY d.CurveName, d.ID
    """    

    conn = database_connection(db_driver, db_server, db_name)
    cursor = conn.cursor()
    cursor.execute(spotPrice_query, (arg_curve_date,curveName))
    curve_rows  = cursor.fetchall()
     # Process results to group by CurveName
    for row in curve_rows:
        curve_name = row[0]
        details = (row[1], row[2])
        curves[curve_name].append(details)

    conn.close()
    return curves

def YieldValue(rows, underlying):
    for row in rows:
        if row[0] == underlying:
            return row[1]
    return "NULL"    


underlying_list = []
def GetUnderlyingYield(underlyings):
    global underlying_list
    if len(underlying_list) == 0:
        #underlyings is a collection of [underlying_tenor, price]
        yield_sql = """
            SELECT [IndexName], [AttributeValue]
            FROM [Market].[vIndexData]
            where ValuationDate = ?
            and InstanceType = 'EOD'
            and DataSource = 'BBG'
            and AttributeName = 'DividendYield'
    """
        conn = database_connection(db_driver, db_server, db_name)
        cursor = conn.cursor()
        cursor.execute(yield_sql, (arg_curve_date,))
        all_rows  = cursor.fetchall()
        underlying_list = list(all_rows)
        conn.close()

     # get the yield
    retCol = [(item1, item2, YieldValue(underlying_list, item1)) for item1, item2 in underlyings]
    return retCol
    

def GetFXcurves():
    curves = defaultdict(list)
    FX_query = """
        SELECT 
            d.CurveName, 
            d.InstrumentType as SecType,
            d.TenorName AS Tenor, 
            d.Rate AS Rate
        FROM Market.vCurveData4PVT AS d 
        WHERE d.InstanceRankOrder=1
        AND d.Groups = 'FX'
        AND d.InstrumentType <> 'Variable'
        AND d.CurveInstanceDate = ?
        ORDER BY d.CurveName, d.ID
    """    

    conn = database_connection(db_driver, db_server, db_name)
    cursor = conn.cursor()
    cursor.execute(FX_query, (arg_curve_date,))
    curve_rows  = cursor.fetchall()
     # Process results to group by CurveName
    for row in curve_rows:
        curve_name = row[0]
        details = (row[1], row[2], row[3])
        curves[curve_name].append(details)

    conn.close()
    return curves



data_bondSpot = defaultdict(list)
ready_data_bondSpot = False
data_FX = defaultdict(list)
ready_data_FX = False

def data_for_template(curve_category, curve_name) -> dict:
    global ready_data_bondSpot
    global ready_data_FX
    global data_bondSpot
    global data_FX

    if curve_category == "BondSpotCurve":
        if (not ready_data_bondSpot):
            data_bondSpot = GetBondSpotCurves()
            ready_data_bondSpot = True
        return data_bondSpot[curve_name]
    elif curve_category == "SpotPriceCurve":
        data_spotPrice = GetPriceCurves(curve_name)
        data_with_yield = GetUnderlyingYield(data_spotPrice[curve_name])
        return data_with_yield
    elif curve_category == "ForwardPriceCurve":
        data_fwdPrice = GetPriceCurves(curve_name)
        return data_fwdPrice[curve_name]
    elif curve_category == "FXCurve":
        if (not ready_data_FX):
            data_FX = GetFXcurves()
            ready_data_FX = True
        return data_FX[curve_name]
    else:
        return []


def template_curves():
    # Track curves that do not have data
    curves_without_data = []
    skip_mode = False 
    try:
        with open(arg_curveTemplate_file, 'r') as input_file:
            with open(arg_curveQuote_out, 'a') as output_file:
                for line in input_file:
                    if skip_mode:
                        if line.strip() == "" or line.startswith("#EndCurve"):
                            skip_mode = False
                            curve_name = ""
                        else:
                            continue

                    if line.startswith("CurveName\t"):
                        # Extract the curve name
                        _, curve_name = line.split('\t')
                    if line.startswith("CurveDate\t") or line.startswith("RefCurveInstanceDate\t"):
                       _, curve_date = line.split('\t')
                       line = line.replace(curve_date.strip(), arg_curve_date)
                    if line.startswith("CurveCategory\t") and len(curve_name) > 0:
                       _, curve_category = line.split('\t')
                    if line.startswith("///:CurveMarketQuotes"):
                        output_file.write(line)
                        next_line = next(input_file, None)
                        output_file.write(next_line)
                        output_file.write("------\t------\t------\n")

                        # Fill in data from database
                        db_data = data_for_template(curve_category.strip(), curve_name.strip())
                        if len(db_data) > 0:
                            for data in db_data:
                                output_file.write("\t".join(str(item) for item in data) + '\n')
                        else:
                            curves_without_data.append(curve_name)
                        skip_mode = True
                        continue

                    output_file.write(line)

        # Write curves without data
        if curves_without_data:
            print("Curves in definition file WITHOUT data:")
            for curve_name in curves_without_data:
                print(f"{curve_name}")
            print("\n")
        print("Data has been written to " + arg_curveQuote_out)

    except Exception as e:
        print(f"An error occurred: {e}")
        exit()

def findur_curves():
    # Track curves that do not have data
    curves_without_data = []

    # Define the SQL query to select data from the table
    query_quote = """
        SELECT 
            d.CurveName, 
            d.CurveCategory,
            d.CurveInstanceDate AS CurveDate,    
            d.InstrumentType as SecType,
            d.TenorName AS Tenor, 
            d.Rate AS Rate, 
            d.Spread AS Spread
        FROM Market.vCurveData4PVT AS d 
		LEFT JOIN Market.Tenor t
		  on d.TenorName = t.TenorName 
        WHERE d.InstanceRankOrder=1
        AND d.CurveInstanceDate = ?
        ORDER BY d.CurveName, t.TermInDays, d.ID
    """

    cds_recoveryRate = """
declare @CurveInstanceDate date = ?;
select SurvivalCurveName, RecovRate from [Market].[fn_GetSurvivalCurveRecoveryRate](@CurveInstanceDate)
order by SurvivalCurveName
"""

    # Get the curve list from curveDef_file
    CPIcurves = []
    CDScurves = []
    IRPcurves = []
    defined_curves = parse_curve_definitions(arg_curveDef_file)
    if len(arg_curveNames) > 0:
        with open(arg_curveNames, 'r') as file:
            for line in file:    
                defined_curves.append((line.strip(), 'ZeroCurve', 'Surv'))

    for curve_name, curveCategory, curveType in defined_curves:
        if curveCategory == "CPICurve":
            CPIcurves.append(curve_name)
        if curveType == "Surv":
            CDScurves.append(curve_name)
        if curveCategory == "IRPCurve":
            IRPcurves.append(curve_name)


    # Create a cursor object using the connection
    conn = database_connection(db_driver, db_server, db_name)
    cursor = conn.cursor()
    if CDScurves:
        cursor.execute(cds_recoveryRate, (arg_curve_date,))
        cds_rows  = cursor.fetchall()
        cds_recoveryRate = defaultdict(list)
        for row in cds_rows:
            curve_name = row[0]
            cds_recoveryRate[curve_name] = row[1]

    cursor.execute(query_quote, (arg_curve_date,))
    # Fetch all rows from the executed query
    curve_rows  = cursor.fetchall()

    # Process results to group by CurveName
    curves = defaultdict(list)
    for row in curve_rows:
        curve_name = row[0]
        details = (row[1], row[2], row[3], row[4], row[5], row[6])
        curves[curve_name].append(details)
    conn.close()

    # Open a text file in write mode
    with open(arg_curveQuote_out, 'a') as file:
        # Iterate over each defined curve
        for curve_name, curveCategory, curveType in defined_curves:
            if curve_name in curves:
                curve = curves[curve_name]
                category, curveDate, secType, tenor, rate, spread = curve[0]
                file.write(f"#BeginCurve\n")
                file.write(f"CurveName\t{curve_name}\n\n")
                file.write(f"///:Parameter\nName\tValue\n")
                file.write(f"CurveCategory\t{category}\n")
                file.write(f"CurveDate\t{curveDate}\n")
                file.write(f"RefCurveInstanceDate\t{curveDate}\n")
                if curve_name in cds_recoveryRate:
                    recoveryRate = cds_recoveryRate[curve_name]
                    file.write(f"RecoveryRate\t{recoveryRate}\n")
                file.write(f"\n")

                file.write(f"///:CurveMarketQuotes\n")
                file.write("SecType\tTenor\tRate\tSpread\n")
                file.write("------\t------\t------\t------\n")

                # Write each row to the file
                # Special case: tenor is like '10immcdx>1immcdxrolls_eu>1cd' for CDX curves and curve_name is like 'Surv_CDX.EM.5Y.USD', get tenor from curve_name
                temp_parts = curve_name.split('.')
                if len(temp_parts) > 1 and len(tenor.split('>')) > 1 and tenor.find('cdx') != -1:
                    tenor = temp_parts[len(temp_parts)-2].lower()
                    file.write('\t'.join(str(item) if item is not None else 'NULL' for item in (secType, tenor, rate, spread)) + '\n')
                else:
                    for category, curveDate, secType, tenor, rate, spread in curve:
                        file.write('\t'.join(str(item) if item is not None else 'NULL' for item in (secType, tenor, rate, spread)) + '\n')
                    
                # Add a blank line between different CurveNames
                file.write('\n#EndCurve\n\n')
            elif curve_name in IRPcurves:
                file.write(f"#BeginCurve\n")
                file.write(f"CurveName\t{curve_name}\n\n")
                file.write(f"///:Parameter\nName\tValue\n")
                file.write(f"CurveCategory\t{curveCategory}\n")
                file.write(f"CurveDate\t{arg_curve_date}\n")
                file.write(f"RefCurveInstanceDate\t{arg_curve_date}\n")
                file.write('\n#EndCurve\n\n')
            else:
                # Track this curve as missing from data (if it's not CPI)
                if not (curve_name in CPIcurves) and not curve_name.startswith("Surv_Generic.") :
                    curves_without_data.append(curve_name)                

    if CPIcurves:
        curves_no_data = CPI_Curves(CPIcurves)
        for curve_name in curves_no_data:
            curves_without_data.append(curve_name)
    
    # Write curves without data
    if curves_without_data:
        print("Curves in definition file WITHOUT data:")
        for curve_name in curves_without_data:
            print(f"{curve_name}")
        print("\n")

    # Close the database connection
    print("Data has been written to " + arg_curveQuote_out)


def findur_curves_df():
    # Define the SQL query to select data from the table
    query_quote = """
  SELECT 
       [CurveName]
      ,[CurveInstanceDate] as CurveDate
      ,[DateOffset]
      ,[Value] as DF
      ,[RefPoint]
      ,[TenorDate]
  FROM [RMDB].[Market].[vCurveOutputData]
  where CurveInstanceDate = ?
  and OutputName = 'DiscFactor'
  order by CurveName, DateOffset  
  """

    # Get the curve list from curveDef_file
    defined_curves = parse_curve_definitions(arg_curveDef_file)

    # Create a cursor object using the connection
    conn = database_connection(db_driver, db_server, db_name)
    cursor = conn.cursor()
    cursor.execute(query_quote, (arg_curve_date,))
    # Fetch all rows from the executed query
    curve_rows  = cursor.fetchall()

    # Process results to group by CurveName
    curves = defaultdict(list)
    for row in curve_rows:
        curve_name = row[0]
        details = (row[1], row[2], row[3], row[4], row[5])
        curves[curve_name].append(details)

    # Track curves that do not have data
    curves_without_data = []

    # Open a text file in write mode
    with open(arg_curveDF_out, 'w') as file:
        # Iterate over each defined curve
        for curve_name, curveCategory, curveType in defined_curves:
            if curve_name in curves:
                curve = curves[curve_name]
                curveDate, dateOffset, df, refPoint, tenorDate = curve[0]
                file.write(f"{curve_name}|{curveDate}\n")
                file.write("DateOffset\tDiscFactor\tRefPoint\tTenorDate\n")
                
                # Write each row to the file
                for curveDate, dateOffset, df, refPoint, tenorDate in curve:
                    file.write('\t'.join(str(item) if item is not None else 'NULL' for item in (dateOffset, df, refPoint, tenorDate)) + '\n')
                    
                # Add a blank line between different CurveNames
                file.write('\n')
            else:
                # Track this curve as missing from data
                curves_without_data.append(curve_name)                

    # Write curves without data
    if curves_without_data:
        print("Curves in definition file WITHOUT DF:")
        for curve_name in curves_without_data:
            print(f"{curve_name}")
        print("\n")

    # Close the database connection
    conn.close()
    print("Data has been written to " + arg_curveDF_out)



#arguments
parser = ArgumentParser()
parser.add_argument("-curveDate", help="the curve date", default="")
parser.add_argument("-curveDefFile", help="the curve definition file", default="")
parser.add_argument("-curveNames", help="the curve name list of 'Surv_Generic'", default="")
parser.add_argument("-curveTemplate", help="the curve template file", default="")
parser.add_argument("-curveQuoteFile", help="the curve quote file", default="")
parser.add_argument("-curveDFFile", help="the curve discount file", default="")
args = parser.parse_args()

arg_curve_date = args.curveDate
arg_curveDef_file = args.curveDefFile
arg_curveNames = args.curveNames
arg_curveTemplate_file = args.curveTemplate
arg_curveQuote_out = args.curveQuoteFile
arg_curveDF_out = args.curveDFFile

if arg_curve_date == '':
    print("Please provide curveDate!")
    exit()
if arg_curveDef_file == '' and arg_curveTemplate_file == '':
    print("Please provide curve definition file or template file!")
    exit()
    
if arg_curveQuote_out == '' and arg_curveDF_out == '':
    arg_curveQuote_out = 'Curve_Quotes.txt'

file_dir = os.path.dirname(__file__)
full_config_path = os.path.join(file_dir, "db_config.json")
try:
    with open(full_config_path) as file:
        config = defaultdict()
        config = json.load(file)

        ##DB configuration
        db_driver = config["Database_info"]["driver"]
        db_server = config["Database_info"]["server_name"]
        db_name = config["Database_info"]["database_name"]
except Exception as e:
    print("Cannot open file " + full_config_path)
    exit()

input_dir = os.path.dirname(arg_curveDef_file)
output_dir = os.path.dirname(arg_curveQuote_out)
if input_dir != "" and output_dir == "":
    arg_curveQuote_out = os.path.join(input_dir, arg_curveQuote_out)


print("\r\nRunning ...\r\n")
if arg_curveQuote_out != '':
    with open(arg_curveQuote_out, 'w') as file:
        file.write(f"#FileDescription\n")
        file.write(f"Generated: Python code\n")
        file.write(f"Database: {db_server}.{db_name}\n")
        file.write(f"ReportDate: {arg_curve_date}\n")
        file.write(f"\n\n")

    if len(arg_curveTemplate_file) > 0:
        template_curves()
    if len(arg_curveDef_file) > 0:
        findur_curves()
    
if len(arg_curveDF_out) > 0:
    findur_curves_df()
